import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubRequest } from "./request.js";
import { BudgetExceeded } from "../../errors.js";

vi.mock("@flightdeck/github-app-jwt", () => ({ createGitHubAppJwt: () => Promise.resolve("jwt") }));
afterEach(() => vi.unstubAllGlobals());

describe("GitHub リクエストの予算", () => {
  it("通信前に数え 46 回目の fetch を拒否する", async () => {
    const fetcher = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        url.includes("access_tokens")
          ? Response.json({ token: "secret", expires_at: "2099-01-01T00:00:00Z" })
          : Response.json({ ok: true })
      )
    );
    vi.stubGlobal("fetch", fetcher);
    const api = new GitHubRequest("budget-test", "key", 123);

    await api.authenticate();
    for (const _ of Array.from({ length: 44 })) await api.request("/test");
    await expect(api.request("/test")).rejects.toBeInstanceOf(BudgetExceeded);

    expect(fetcher).toHaveBeenCalledTimes(45);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("GraphQL errors があれば部分データを拒否する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("access_tokens")
            ? Response.json({ token: "secret", expires_at: "2099-01-01T00:00:00Z" })
            : Response.json({ data: { repository: {} }, errors: [{ message: "unavailable" }] })
        )
      )
    );
    const api = new GitHubRequest("graphql-test", "key", 125);

    await api.authenticate();
    await expect(api.graphql("query { viewer { login } }", {})).rejects.toThrow("GraphQL error");
  });

  it("不正な JSON と timeout を安全なエラーに変換する", async () => {
    const fetcher = vi.fn((url: string) => {
      if (url.includes("access_tokens"))
        return Promise.resolve(Response.json({ token: "secret", expires_at: "2099-01-01T00:00:00Z" }));
      return Promise.resolve(new Response("secret invalid JSON"));
    });
    vi.stubGlobal("fetch", fetcher);
    const api = new GitHubRequest("response-test", "key", 126);

    await api.authenticate();
    await expect(api.request("/test")).rejects.toMatchObject({ code: "invalid_response", errorName: "SyntaxError" });
    fetcher.mockRejectedValueOnce(new DOMException("secret", "TimeoutError"));
    await expect(api.request("/test")).rejects.toMatchObject({ code: "timeout", message: "GitHub request timed out" });
  });

  it("上限を超える応答を拒否する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("access_tokens")
            ? Response.json({ token: "secret", expires_at: "2099-01-01T00:00:00Z" })
            : new Response("x".repeat(100))
        )
      )
    );
    const api = new GitHubRequest("size-test", "key", 124);

    await api.authenticate();
    await expect(api.request("/test", "GET", undefined, 10)).rejects.toThrow("response too large");
  });
});
