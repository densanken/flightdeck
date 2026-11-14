import { afterEach, describe, expect, it, vi } from "vitest";

import { SubrequestLimitExceeded } from "./errors.js";
import { GitHubRequest } from "./request.js";

vi.mock("@flightdeck/github-app-jwt", () => ({ createGitHubAppJwt: () => Promise.resolve("jwt") }));
afterEach(() => vi.unstubAllGlobals());

describe("GitHub リクエストの回数上限", () => {
  it("通信前に数え 46 回目の fetch を拒否する", async () => {
    const fetcher = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        url.includes("access_tokens")
          ? Response.json({ token: "secret", expires_at: "2099-01-01T00:00:00Z" })
          : Response.json({ ok: true })
      )
    );
    vi.stubGlobal("fetch", fetcher);
    const api = new GitHubRequest("limit-test", "key", 123, "flightdeck-test");

    await api.authenticate();
    for (const _ of Array.from({ length: 44 })) await api.request("/test");
    await expect(api.request("/test")).rejects.toBeInstanceOf(SubrequestLimitExceeded);

    expect(fetcher).toHaveBeenCalledTimes(45);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      headers: { "user-agent": "flightdeck-test" },
    });
  });

  it.each([
    ["flightdeck-clearance", 127],
    ["flightdeck-autopilot", 128],
  ])("%s の User-Agent を認証と API の両方に送る", async (userAgent, installation) => {
    const fetcher = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        url.includes("access_tokens")
          ? Response.json({ token: "secret", expires_at: "2099-01-01T00:00:00Z" })
          : Response.json({ ok: true })
      )
    );
    vi.stubGlobal("fetch", fetcher);
    const api = new GitHubRequest(userAgent, "key", installation, userAgent);

    await api.authenticate();
    await api.request("/test");

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) {
      expect(call[1]).toMatchObject({ headers: { "user-agent": userAgent } });
    }
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
    const api = new GitHubRequest("graphql-test", "key", 125, "flightdeck-test");

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
    const api = new GitHubRequest("response-test", "key", 126, "flightdeck-test");

    await api.authenticate();
    await expect(api.request("/test")).rejects.toMatchObject({ code: "invalid_response", errorName: "SyntaxError" });
    fetcher.mockRejectedValueOnce(new DOMException("secret", "TimeoutError"));
    await expect(api.request("/test")).rejects.toMatchObject({ code: "timeout", message: "GitHub request timed out" });
  });

  it.each([
    ["残量 0", { "x-ratelimit-remaining": "0" }, "forbidden", true],
    ["retry-after", { "retry-after": "10" }, "forbidden", true],
    ["rate limit の本文", {}, "rate limit exceeded", true],
    ["権限による拒否", {}, "Resource not accessible", false],
  ])("403 の%sを識別する", async (_name, headers, body, rateLimited) => {
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("access_tokens")
          ? Response.json({ token: "secret", expires_at: "2099-01-01T00:00:00Z" })
          : new Response(body, { status: 403, headers })
      )
    );
    vi.stubGlobal("fetch", fetcher);
    const api = new GitHubRequest(`status-${_name}`, "key", 129, "flightdeck-test");
    await api.authenticate();
    await expect(api.request("/test")).rejects.toMatchObject({ status: 403, rateLimited });
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
    const api = new GitHubRequest("size-test", "key", 124, "flightdeck-test");

    await api.authenticate();
    await expect(api.request("/test", "GET", undefined, 10)).rejects.toThrow("response too large");
  });
});
