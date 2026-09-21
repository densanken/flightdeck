import { describe, expect, it, vi } from "vitest";

import { createIssueComment, deleteIssueComment, listIssueComments, updateIssueComment } from "./issue-comments.js";

const jsonResponse = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers });

const baseInput = () => ({
  owner: "owner",
  repo: "repo",
  installationToken: "token",
  signal: new AbortController().signal,
});

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

describe("listIssueComments", () => {
  it("rel=next をたどり、すべての page のコメントを返す", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1, body: "first", user: { id: 10 } }], 200, {
          Link: '<https://api.github.com/repos/owner/repo/issues/7/comments?per_page=100&page=2>; rel="next"',
        })
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 2, body: null, user: null }], 200));

    await expect(listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl })).resolves.toEqual([
      { id: 1, body: "first", user: { id: 10 } },
      { id: 2, body: null, user: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("pagination の循環、外部 host、想定外の path を指す next link を拒否する", async () => {
    const cycleUrl = "https://api.github.com/repos/owner/repo/issues/7/comments?per_page=100&page=1";
    const cycleFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([], 200, {
        Link: `<${cycleUrl}>; rel="next"`,
      })
    );
    await expect(listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl: cycleFetch })).rejects.toThrow(
      "cycle"
    );

    const externalFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([], 200, {
        Link: '<https://evil.example/comments?page=2>; rel="next"',
      })
    );
    await expect(listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl: externalFetch })).rejects.toThrow(
      "pagination URL"
    );

    const wrongPathFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([], 200, {
        Link: '<https://api.github.com/user/installations?page=2>; rel="next"',
      })
    );
    await expect(
      listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl: wrongPathFetch })
    ).rejects.toThrow("pagination path");
  });

  it("page 数の上限に達したら error にする", async () => {
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      const page = Number(new URL(requestUrl(url)).searchParams.get("page"));
      return Promise.resolve(
        jsonResponse([], 200, {
          Link: `<https://api.github.com/repos/owner/repo/issues/7/comments?per_page=100&page=${String(page + 1)}>; rel="next"`,
        })
      );
    });

    await expect(listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl })).rejects.toThrow("page limit");
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it("shape が不正な成功 response を GITHUB_API_FAILED で reject する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([{ id: "bad" }], 200));
    await expect(listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl })).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });

  it("1 page のコメント数が上限を超えたら error にする", async () => {
    const oversized = Array.from({ length: 1_001 }, (_, index) => ({
      id: index + 1,
      body: "x",
      user: { id: 10 },
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(oversized, 200));

    await expect(listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl })).rejects.toThrow(
      "safety limit"
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("user id が正の整数でないコメントを拒否する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse([{ id: 1, body: "x", user: { id: 0 } }], 200));
    await expect(listIssueComments({ ...baseInput(), pullRequestNumber: 7, fetchImpl })).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });
});

describe("Issue Comment の作成、更新、削除", () => {
  it("指定したコメントを POST, PATCH, DELETE の順で操作する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 10 }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: 10 }, 200))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await createIssueComment({ ...baseInput(), pullRequestNumber: 7, body: "new", fetchImpl });
    await updateIssueComment({ ...baseInput(), commentId: 10, body: "updated", fetchImpl });
    await deleteIssueComment({ ...baseInput(), commentId: 10, fetchImpl });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://api.github.com/repos/owner/repo/issues/7/comments", "POST"],
      ["https://api.github.com/repos/owner/repo/issues/comments/10", "PATCH"],
      ["https://api.github.com/repos/owner/repo/issues/comments/10", "DELETE"],
    ]);
  });

  it("削除時の 404 は解決済みとして成功扱いにする", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(deleteIssueComment({ ...baseInput(), commentId: 10, fetchImpl })).resolves.toBeUndefined();
  });
});
