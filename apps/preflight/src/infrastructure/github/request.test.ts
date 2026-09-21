import { describe, expect, it, vi } from "vitest";

import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, nextPageUrl, readGitHubJson } from "./request.js";
import { GitHubError } from "../../errors.js";

const request = (overrides: Partial<Parameters<typeof githubRequest>[0]> = {}) =>
  githubRequest({
    url: "https://api.github.com/test",
    method: "GET",
    token: "token",
    expectedStatuses: [200],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })),
    signal: new AbortController().signal,
    ...overrides,
  });

const responseWithCancelSpy = (status: number, headers?: HeadersInit) => {
  const response = new Response("response body", { status, headers });
  const body = response.body;
  if (body === null) throw new Error("test response must have a body");
  const cancel = vi.spyOn(body, "cancel");
  return { response, cancel };
};

describe("githubRequest retry", () => {
  it("fetch 中の abort を REQUEST_TIMEOUT に分類し、元の理由を保持する", async () => {
    const controller = new AbortController();
    const timeoutReason = new DOMException("deadline exceeded", "TimeoutError");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>(() => {
          // raceWithSignal が caller の abort を処理するまで pending を維持する
        })
    );

    const result = request({ fetchImpl, signal: controller.signal });
    controller.abort(timeoutReason);

    await expect(result).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      statusCode: 504,
      cause: timeoutReason,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("signal reason が Error でなくても cause にその値を保持する", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    const result = request({ fetchImpl, signal: controller.signal });
    controller.abort("deadline marker");

    await expect(result).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      cause: "deadline marker",
    });
  });

  it("signal reason が undefined の場合も timeout 分類を維持する", async () => {
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const fetchImpl = vi.fn<typeof fetch>();

    const result = request({ fetchImpl, signal });
    await expect(result).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "REQUEST_TIMEOUT" &&
        "cause" in error &&
        error.cause === undefined
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetch が signal の更新より先に AbortError を返しても REQUEST_TIMEOUT に分類する", async () => {
    const abortError = new DOMException("fetch aborted", "AbortError");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(abortError);

    await expect(request({ method: "POST", fetchImpl })).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      cause: abortError,
    });
  });

  it("retry sleep 中の abort を REQUEST_TIMEOUT に分類し、再試行しない", async () => {
    const controller = new AbortController();
    const timeoutReason = new DOMException("deadline exceeded", "TimeoutError");
    const sleepStarted = Promise.withResolvers<undefined>();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockImplementation(() => {
      sleepStarted.resolve(undefined);
      return new Promise<undefined>(() => {
        // caller の signal が retry wait を中断するまで pending を維持する
      });
    });

    const result = request({
      fetchImpl,
      signal: controller.signal,
      retry: { sleep, random: () => 0, now: () => 1_000 },
    });
    await sleepStarted.promise;
    controller.abort(timeoutReason);

    await expect(result).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      statusCode: 504,
      cause: timeoutReason,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("通常の network error は GITHUB_API_FAILED の cause として保持する", async () => {
    const networkError = new TypeError("network");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(networkError);

    await expect(request({ method: "POST", fetchImpl })).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
      statusCode: 502,
      cause: networkError,
    });
  });

  it("GET の network error と 502 を短い backoff 後に再試行する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(request({ fetchImpl, retry: { sleep, random: () => 0, now: () => 1_000 } })).resolves.toMatchObject({
      status: 200,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("Retry-After の秒数を優先する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "0.25", "X-RateLimit-Reset": "9999999999" },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await request({ fetchImpl, retry: { sleep, now: () => 1_000 } });

    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("403 は Retry-After がある rate limit response だけ短く再試行する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 403, headers: { "Retry-After": "0.1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(request({ fetchImpl, retry: { sleep, now: () => 1_000 } })).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("通常の permission 403 は再試行しない", async () => {
    const { response, cancel } = responseWithCancelSpy(403);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(request({ fetchImpl, retry: { sleep, now: () => 1_000 } })).rejects.toMatchObject({
      githubStatus: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rate limit 403 は Retry-After がなければ X-RateLimit-Reset の epoch 秒まで待つ", async () => {
    const nowMs = 1_000_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 403,
          headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1001" },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await request({ fetchImpl, retry: { sleep, now: () => nowMs, retryBudgetMs: 2_000 } });
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("X-RateLimit-Reset が retry budget 外なら待たずに Queue consumer へ失敗を返す", async () => {
    const nowMs = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1005" },
      })
    );
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      request({ fetchImpl, retry: { sleep, now: () => nowMs, retryBudgetMs: 2_000 } })
    ).rejects.toMatchObject({ githubStatus: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("Retry-After が retry budget を超えると待たずに失敗する", async () => {
    const { response, cancel } = responseWithCancelSpy(429, {
      "Retry-After": "3",
      "X-GitHub-Request-Id": "request-id",
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      request({ fetchImpl, retry: { sleep, now: () => 1_000, retryBudgetMs: 2_000 } })
    ).rejects.toMatchObject({
      githubStatus: 429,
      githubRequestId: "request-id",
      retryAfter: "3",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("mutation は明示しない限り blind retry しない", async () => {
    const { response, cancel } = responseWithCancelSpy(502);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(request({ method: "POST", fetchImpl })).rejects.toMatchObject({ githubStatus: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("認証 POST は明示したときだけ再試行できる", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      request({ method: "POST", fetchImpl, retry: { sleep, random: () => 0, now: () => 1_000 } })
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retry 継続時と最終 attempt の両方で response body を破棄する", async () => {
    const first = responseWithCancelSpy(502);
    const last = responseWithCancelSpy(503);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response).mockResolvedValueOnce(last.response);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      request({ fetchImpl, retry: { maxAttempts: 2, sleep, random: () => 0, now: () => 1_000 } })
    ).rejects.toMatchObject({ githubStatus: 503 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(last.cancel).toHaveBeenCalledOnce();
    expect(first.cancel.mock.invocationCallOrder[0]).toBeLessThan(sleep.mock.invocationCallOrder[0] ?? 0);
  });

  it("response body の破棄失敗で元の GitHubError を上書きしない", async () => {
    const { response, cancel } = responseWithCancelSpy(403, {
      "X-GitHub-Request-Id": "request-id",
      "Retry-After": "7",
    });
    cancel.mockRejectedValue(new Error("cancel failed"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(request({ fetchImpl })).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
      githubStatus: 403,
      githubRequestId: "request-id",
      retryAfter: "7",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("response body の破棄が完了しなくても元の GitHubError を返す", async () => {
    const { response, cancel } = responseWithCancelSpy(503, {
      "X-GitHub-Request-Id": "request-id",
    });
    cancel.mockReturnValue(new Promise<void>(() => undefined));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(request({ method: "POST", fetchImpl })).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
      githubStatus: 503,
      githubRequestId: "request-id",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("成功 response の body は caller が読み取るため破棄しない", async () => {
    const { response, cancel } = responseWithCancelSpy(200);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(request({ fetchImpl })).resolves.toBe(response);
    expect(cancel).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("response body");
  });
});

describe("readGitHubJson", () => {
  it("body 読み取り中の abort を REQUEST_TIMEOUT に分類し、元の理由を保持する", async () => {
    const controller = new AbortController();
    const timeoutReason = new DOMException("deadline exceeded", "TimeoutError");
    const response = new Response("{}");
    vi.spyOn(response, "json").mockReturnValue(new Promise<unknown>(() => undefined));

    const result = readGitHubJson(response, "GITHUB_API_FAILED", controller.signal);
    controller.abort(timeoutReason);

    await expect(result).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      statusCode: 504,
      cause: timeoutReason,
    });
  });

  it("invalid JSON の元例外を GITHUB_API_FAILED の cause として保持する", async () => {
    const parseError = new SyntaxError("invalid JSON");
    const response = new Response("{}");
    vi.spyOn(response, "json").mockRejectedValue(parseError);

    await expect(readGitHubJson(response, "GITHUB_API_FAILED", new AbortController().signal)).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
      cause: parseError,
    });
  });
});

describe("invalidShapeError", () => {
  it("resource 名を含む message と、切り分けに使う GitHub の status と request ID を持つ error を返す", () => {
    const response = new Response(null, {
      status: 422,
      headers: { "X-GitHub-Request-Id": "request-id" },
    });

    const error = invalidShapeError(response, "GITHUB_AUTH_FAILED", "installation token");

    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).toBe("GitHub installation token response has an invalid shape");
    expect(error.code).toBe("GITHUB_AUTH_FAILED");
    expect(error.statusCode).toBe(502);
    expect(error.githubStatus).toBe(422);
    expect(error.githubRequestId).toBe("request-id");
  });

  it("X-GitHub-Request-Id がない response では githubRequestId を undefined にする", () => {
    const error = invalidShapeError(new Response(null, { status: 200 }), "GITHUB_API_FAILED", "issue comments");

    expect(error.message).toBe("GitHub issue comments response has an invalid shape");
    expect(error.code).toBe("GITHUB_API_FAILED");
    expect(error.githubStatus).toBe(200);
    expect(error.githubRequestId).toBeUndefined();
  });
});

describe("nextPageUrl", () => {
  const commentsPath = "/repos/owner/repo/issues/7/comments";
  const currentUrl = `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=1`;
  const messages = { invalidUrl: "Invalid GitHub pagination URL", invalidPath: "Invalid GitHub pagination path" };

  it("相対 URL の Link header を現在の URL を base にして絶対 URL へ解決する", () => {
    const header = '<comments?per_page=100&page=2>; rel="next"';

    expect(nextPageUrl(header, currentUrl, commentsPath, messages)).toBe(
      `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=2`
    );
  });

  it("相対 URL でも別 path への誘導は拒否する", () => {
    const header = '</user/installations?page=2>; rel="next"';

    expect(() => nextPageUrl(header, currentUrl, commentsPath, messages)).toThrow(messages.invalidPath);
  });

  it("別 origin への誘導は拒否する", () => {
    const header = '<https://evil.example/repos/owner/repo/issues/7/comments?page=2>; rel="next"';

    expect(() => nextPageUrl(header, currentUrl, commentsPath, messages)).toThrow(messages.invalidUrl);
  });

  it('parameter の順序に関わらず rel="next" の part をたどる', () => {
    const nextUrl = `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=2`;

    expect(nextPageUrl(`<${nextUrl}>; rel="next"; type="application/json"`, currentUrl, commentsPath, messages)).toBe(
      nextUrl
    );
    expect(nextPageUrl(`<${nextUrl}>; type="application/json"; rel="next"`, currentUrl, commentsPath, messages)).toBe(
      nextUrl
    );
  });

  it('rel="next" を接頭辞に持つ別の rel を next と取り違えない', () => {
    const header = `<${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=2>; rel="next-page"`;

    expect(nextPageUrl(header, currentUrl, commentsPath, messages)).toBeNull();
  });

  it("空白区切りで複数の関係型を持つ rel の part もたどる", () => {
    const nextUrl = `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=2`;

    expect(nextPageUrl(`<${nextUrl}>; rel="prev next"`, currentUrl, commentsPath, messages)).toBe(nextUrl);
    expect(nextPageUrl(`<${nextUrl}>; rel="next prev"`, currentUrl, commentsPath, messages)).toBe(nextUrl);
  });

  it("引用符のない rel=next の part もたどる", () => {
    const nextUrl = `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=2`;

    expect(nextPageUrl(`<${nextUrl}>; rel=next`, currentUrl, commentsPath, messages)).toBe(nextUrl);
    expect(nextPageUrl(`<${nextUrl}>; rel=next; type="application/json"`, currentUrl, commentsPath, messages)).toBe(
      nextUrl
    );
  });

  it("next 以外の rel しかない Link header は最終ページとして null を返す", () => {
    const link = `<${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=2>`;

    expect(nextPageUrl(`${link}; rel="nextish"`, currentUrl, commentsPath, messages)).toBeNull();
    expect(nextPageUrl(`${link}; rel="prev"`, currentUrl, commentsPath, messages)).toBeNull();
    expect(nextPageUrl(`${link}; rel="last"`, currentUrl, commentsPath, messages)).toBeNull();
    expect(nextPageUrl(link, currentUrl, commentsPath, messages)).toBeNull();
  });

  it("next の part から URL を取り出せない場合は最終ページとして扱わず error にする", () => {
    const header = `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=2; rel="next"`;

    expect(() => nextPageUrl(header, currentUrl, commentsPath, messages)).toThrow("pagination link has no URL");
  });

  it('複数の rel のうち rel="next" の part だけをたどる', () => {
    const header = [
      `<${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=1>; rel="prev"`,
      `<${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=3>; rel="next"`,
      `<${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=9>; rel="last"`,
    ].join(", ");

    expect(nextPageUrl(header, currentUrl, commentsPath, messages)).toBe(
      `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=3`
    );
  });

  it("Link header がない場合は最終ページとして null を返す", () => {
    expect(nextPageUrl(null, currentUrl, commentsPath, messages)).toBeNull();
  });
});
