import { describe, expect, it, vi } from "vitest";

import { GitHubInstallationSession } from "./installation-session.js";

import type { GitHubInstallationSessionOptions } from "./installation-session.js";

type CreateAppJwt = NonNullable<GitHubInstallationSessionOptions["createAppJwt"]>;
type CreateInstallationToken = NonNullable<GitHubInstallationSessionOptions["createInstallationToken"]>;
type ResolveAppBotUserId = NonNullable<GitHubInstallationSessionOptions["resolveAppBotUserId"]>;

const createFixture = () => {
  const createAppJwt = vi.fn<CreateAppJwt>().mockResolvedValue("app-jwt");
  const createInstallationToken = vi.fn<CreateInstallationToken>().mockResolvedValue("installation-token");
  const resolveAppBotUserId = vi.fn<ResolveAppBotUserId>().mockResolvedValue(4242);
  const appBotIdentityCache = new Map<string, number>();
  const session = new GitHubInstallationSession({
    installationId: 42,
    getCredentials: () => ({ appId: "12345", privateKeyPem: "private-key" }),
    fetchImpl: vi.fn<typeof fetch>(),
    appBotIdentityCache,
    createAppJwt,
    createInstallationToken,
    resolveAppBotUserId,
  });
  return { session, createAppJwt, createInstallationToken, resolveAppBotUserId, appBotIdentityCache };
};

describe("GitHubInstallationSession", () => {
  it("複数の API 操作で 1 つの installation token を共有する", async () => {
    const fixture = createFixture();

    await expect(fixture.session.getInstallationToken(new AbortController().signal)).resolves.toBe(
      "installation-token"
    );
    await expect(fixture.session.getInstallationToken(new AbortController().signal)).resolves.toBe(
      "installation-token"
    );

    expect(fixture.createAppJwt).toHaveBeenCalledOnce();
    expect(fixture.createInstallationToken).toHaveBeenCalledOnce();
  });

  it("soft signal の abort で reject したあとも、取得済みの token を後続の呼び出しで再利用する", async () => {
    const fixture = createFixture();
    await fixture.session.getInstallationToken(new AbortController().signal);
    const softController = new AbortController();
    const timeoutReason = new Error("soft deadline");
    softController.abort(timeoutReason);

    await expect(fixture.session.getInstallationToken(softController.signal)).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      statusCode: 504,
      cause: timeoutReason,
    });
    await expect(fixture.session.getInstallationToken(new AbortController().signal)).resolves.toBe(
      "installation-token"
    );
    expect(fixture.createInstallationToken).toHaveBeenCalledOnce();
  });

  it("token 生成そのものが失敗したときだけ次の呼び出しで再取得する", async () => {
    const fixture = createFixture();
    const tokenError = new Error("token request failed");
    fixture.createInstallationToken.mockRejectedValueOnce(tokenError);

    await expect(fixture.session.getInstallationToken(new AbortController().signal)).rejects.toMatchObject({
      code: "GITHUB_AUTH_FAILED",
      statusCode: 502,
      cause: tokenError,
    });
    await expect(fixture.session.getInstallationToken(new AbortController().signal)).resolves.toBe(
      "installation-token"
    );
    expect(fixture.createInstallationToken).toHaveBeenCalledTimes(2);
  });

  it("JWT 生成に失敗した場合も reject 済み cache を破棄して次の呼び出しで再取得する", async () => {
    const fixture = createFixture();
    const jwtError = new Error("JWT generation failed");
    fixture.createAppJwt.mockRejectedValueOnce(jwtError);

    await expect(fixture.session.getInstallationToken(new AbortController().signal)).rejects.toMatchObject({
      code: "GITHUB_AUTH_FAILED",
      cause: jwtError,
    });
    await expect(fixture.session.getInstallationToken(new AbortController().signal)).resolves.toBe(
      "installation-token"
    );
    expect(fixture.createAppJwt).toHaveBeenCalledTimes(2);
    expect(fixture.createInstallationToken).toHaveBeenCalledOnce();
  });

  it("最初の caller が abort しても共有中の token 生成と別 caller を止めない", async () => {
    const fixture = createFixture();
    const creationStarted = Promise.withResolvers<undefined>();
    const token = Promise.withResolvers<string>();
    fixture.createInstallationToken.mockImplementationOnce(() => {
      creationStarted.resolve(undefined);
      return token.promise;
    });
    const firstController = new AbortController();
    const timeoutReason = new Error("soft deadline");

    const first = fixture.session.getInstallationToken(firstController.signal);
    await creationStarted.promise;
    const second = fixture.session.getInstallationToken(new AbortController().signal);
    firstController.abort(timeoutReason);

    await expect(first).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", cause: timeoutReason });
    token.resolve("shared-token");
    await expect(second).resolves.toBe("shared-token");
    await expect(fixture.session.getInstallationToken(new AbortController().signal)).resolves.toBe("shared-token");
    expect(fixture.createInstallationToken).toHaveBeenCalledOnce();
  });

  it("共有 token 生成そのものの abort は全 caller へ伝え、失敗した Promise を破棄する", async () => {
    const operationController = new AbortController();
    const fixture = createFixture();
    const creationStarted = Promise.withResolvers<undefined>();
    fixture.createInstallationToken.mockImplementationOnce(
      ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          creationStarted.resolve(undefined);
          signal.addEventListener(
            "abort",
            () => {
              const reason = signal.reason as unknown;
              reject(reason instanceof Error ? reason : new Error("Shared operation aborted", { cause: reason }));
            },
            { once: true }
          );
        })
    );
    const session = new GitHubInstallationSession({
      installationId: 42,
      getCredentials: () => ({ appId: "12345", privateKeyPem: "private-key" }),
      createAppJwt: fixture.createAppJwt,
      createInstallationToken: fixture.createInstallationToken,
      createSharedOperationSignal: vi
        .fn<() => AbortSignal>()
        .mockReturnValueOnce(operationController.signal)
        .mockReturnValue(new AbortController().signal),
    });
    const first = session.getInstallationToken(new AbortController().signal);
    await creationStarted.promise;
    const second = session.getInstallationToken(new AbortController().signal);
    const timeoutReason = new DOMException("shared deadline", "TimeoutError");
    operationController.abort(timeoutReason);

    await expect(first).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", cause: timeoutReason });
    await expect(second).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", cause: timeoutReason });
    await expect(session.getInstallationToken(new AbortController().signal)).resolves.toBe("installation-token");
    expect(fixture.createInstallationToken).toHaveBeenCalledTimes(2);
  });

  it("Bot identity は解決に成功したときだけ cache する", async () => {
    const fixture = createFixture();
    const identityError = new Error("identity request failed");
    fixture.resolveAppBotUserId.mockRejectedValueOnce(identityError);

    await expect(fixture.session.getAuthenticatedAppBotUserId(new AbortController().signal)).rejects.toMatchObject({
      code: "GITHUB_AUTH_FAILED",
      statusCode: 502,
      cause: identityError,
    });
    expect(fixture.appBotIdentityCache.size).toBe(0);
    await expect(fixture.session.getAuthenticatedAppBotUserId(new AbortController().signal)).resolves.toBe(4242);
    await expect(fixture.session.getAuthenticatedAppBotUserId(new AbortController().signal)).resolves.toBe(4242);
    expect(fixture.resolveAppBotUserId).toHaveBeenCalledTimes(2);
    expect(fixture.appBotIdentityCache.get("12345")).toBe(4242);
  });

  it("caller が abort しても共有中の Bot identity 解決を継続して別 caller と cache に渡す", async () => {
    const fixture = createFixture();
    const resolutionStarted = Promise.withResolvers<undefined>();
    const identity = Promise.withResolvers<number>();
    fixture.resolveAppBotUserId.mockImplementationOnce(() => {
      resolutionStarted.resolve(undefined);
      return identity.promise;
    });
    const firstController = new AbortController();
    const first = fixture.session.getAuthenticatedAppBotUserId(firstController.signal);
    await resolutionStarted.promise;
    const second = fixture.session.getAuthenticatedAppBotUserId(new AbortController().signal);
    const timeoutReason = new Error("soft deadline");
    firstController.abort(timeoutReason);

    await expect(first).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", cause: timeoutReason });
    identity.resolve(4242);
    await expect(second).resolves.toBe(4242);
    await expect(fixture.session.getAuthenticatedAppBotUserId(new AbortController().signal)).resolves.toBe(4242);
    expect(fixture.resolveAppBotUserId).toHaveBeenCalledOnce();
    expect(fixture.appBotIdentityCache.get("12345")).toBe(4242);
  });

  it("cache 済み Bot identity の caller abort も REQUEST_TIMEOUT に分類する", async () => {
    const fixture = createFixture();
    fixture.appBotIdentityCache.set("12345", 4242);
    const controller = new AbortController();
    const timeoutReason = new Error("soft deadline");
    controller.abort(timeoutReason);

    await expect(fixture.session.getAuthenticatedAppBotUserId(controller.signal)).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      statusCode: 504,
      cause: timeoutReason,
    });
    expect(fixture.resolveAppBotUserId).not.toHaveBeenCalled();
  });
});
