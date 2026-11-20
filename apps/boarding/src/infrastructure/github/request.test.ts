import { describe, expect, it, vi } from "vitest";

import { GitHubRequest } from "./request.js";

const json = (value: unknown) => Response.json(value);

describe("GitHubRequest", () => {
  it("GraphQL の data を返す", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ data: { ok: true } }));
    const request = new GitHubRequest(fetcher);
    await expect(request.graphql("token", "query { ok }", {})).resolves.toEqual({ ok: true });
  });

  it("GraphQL の部分的な失敗を拒否する", async () => {
    const request = new GitHubRequest(vi.fn().mockResolvedValue(json({ data: { ok: true }, errors: [{}] })));
    await expect(request.graphql("token", "query { ok }", {})).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("API の失敗を既知のエラーにする", async () => {
    const request = new GitHubRequest(vi.fn().mockRejectedValue(new Error("network")));
    await expect(request.call({ method: "GET", path: "/test", token: "token" })).rejects.toMatchObject({
      code: "API_ERROR",
    });
  });

  it.each([
    [{ "retry-after": "60" }, true],
    [{ "x-ratelimit-remaining": "0" }, true],
    [{ "x-ratelimit-remaining": "10" }, false],
    [{}, false],
  ])("403 のヘッダー %o からレート制限を判定する", async (headers, rateLimited) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 403, headers }));
    const request = new GitHubRequest(fetcher);
    await expect(request.call({ method: "GET", path: "/x", token: "t" })).rejects.toMatchObject({
      status: 403,
      rateLimited,
    });
  });

  it("サイズを申告しない大きな応答を拒否する", async () => {
    const request = new GitHubRequest(
      vi.fn().mockImplementation(() => Promise.resolve(new Response("x".repeat(1024 * 1024 + 1))))
    );
    await expect(request.call({ method: "GET", path: "/test", token: "token" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("評価用の上限を超えても出版用の予算を使える", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({})));
    const publication = new GitHubRequest(fetcher);
    const evaluation = publication.withLimit(1);
    await evaluation.call({ method: "GET", path: "/test", token: "token" });
    await expect(evaluation.call({ method: "GET", path: "/test", token: "token" })).rejects.toMatchObject({
      code: "SUBREQUEST_LIMIT",
    });
    await expect(publication.call({ method: "GET", path: "/test", token: "token" })).resolves.toEqual({});
  });

  it("予算を超えるリクエストを送らない", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({})));
    const request = new GitHubRequest(fetcher);
    for (const _index of Array.from({ length: 35 })) {
      await request.call({ method: "GET", path: "/test", token: "token" });
    }
    await expect(request.call({ method: "GET", path: "/test", token: "token" })).rejects.toMatchObject({
      code: "SUBREQUEST_LIMIT",
    });
    expect(fetcher).toHaveBeenCalledTimes(35);
  });
});
