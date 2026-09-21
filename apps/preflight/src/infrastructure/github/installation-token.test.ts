import { describe, expect, it, vi } from "vitest";

import { createInstallationAccessToken } from "./installation-token.js";

const jsonResponse = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const tokenInput = (fetchImpl: typeof fetch, signal: AbortSignal = new AbortController().signal) => ({
  installationId: 42,
  appJwt: "app-jwt",
  fetchImpl,
  signal,
});

describe("createInstallationAccessToken", () => {
  it("GitHub App JWT と既定の header を付けて access token endpoint を POST する", async () => {
    const token = "ghs_12345_stateless-token-with-variable-length";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ token, expires_at: "2026-07-16T01:00:00Z" }, 201));

    await expect(createInstallationAccessToken(tokenInput(fetchImpl))).resolves.toBe(token);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(init).toMatchObject({ method: "POST" });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer app-jwt");
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("X-GitHub-Api-Version")).toBe("2026-03-10");
    expect(headers.get("User-Agent")).toBe("preflight");
  });

  it("2xx 以外の response からは安全な error metadata だけを残す", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ message: "rate limited" }, 429, {
        "x-github-request-id": "request-id",
        "retry-after": "60",
      })
    );

    await expect(createInstallationAccessToken(tokenInput(fetchImpl))).rejects.toMatchObject({
      code: "GITHUB_AUTH_FAILED",
      statusCode: 502,
      githubStatus: 429,
      githubRequestId: "request-id",
      retryAfter: "60",
    });
  });

  it("成功 response の shape が不正なとき、token らしき値を message に出さず reject する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ token: "secret" }, 201));
    try {
      await createInstallationAccessToken(tokenInput(fetchImpl));
      throw new Error("Expected createInstallationAccessToken to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "GITHUB_AUTH_FAILED" });
      expect(error instanceof Error ? error.message : "").not.toContain("secret");
    }
  });

  it("network error を GITHUB_AUTH_FAILED へ変換し、JWT を message に出さない", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network error with app-jwt"));
    try {
      await createInstallationAccessToken(tokenInput(fetchImpl));
      throw new Error("Expected createInstallationAccessToken to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "GITHUB_AUTH_FAILED" });
      expect(error instanceof Error ? error.message : "").not.toContain("app-jwt");
    }
  });

  it("呼び出し元の deadline signal を fetch へ渡す", async () => {
    const signal = AbortSignal.timeout(9_000);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ token: "installation-token", expires_at: "2026-07-16T01:00:00Z" }, 201));
    await createInstallationAccessToken(tokenInput(fetchImpl, signal));

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(signal);
  });
});
