import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubInstallationTokenProvider } from "./auth.js";
import { GitHubRequest } from "./request.js";

vi.mock("@flightdeck/github-app-jwt", () => ({ createGitHubAppJwt: vi.fn().mockResolvedValue("jwt") }));

beforeEach(() => vi.clearAllMocks());

describe("GitHubInstallationTokenProvider", () => {
  it("installation token を取得し同じ実行中は再利用する", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ token: "installation-token", permissions: { members: "read" } }))
      );
    const provider = new GitHubInstallationTokenProvider({
      request: new GitHubRequest(fetcher),
      appId: "1",
      privateKeyPem: "key",
      installationId: 42,
    });
    await expect(Promise.all([provider.getToken(), provider.getToken()])).resolves.toEqual([
      "installation-token",
      "installation-token",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.github.com/app/installations/42/access_tokens");
  });

  it("対象リポジトリの Installation と Org が一致しない場合は失敗する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ id: 43, account: { login: "densanken", type: "Organization" } }));
    const provider = new GitHubInstallationTokenProvider({
      request: new GitHubRequest(fetcher),
      appId: "1",
      privateKeyPem: "key",
      installationId: 42,
    });
    await expect(provider.verifyInstallation()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("対象の Installation ID でも異なる Org は拒否する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ id: 42, account: { login: "other", type: "Organization" } }));
    const provider = new GitHubInstallationTokenProvider({
      request: new GitHubRequest(fetcher),
      appId: "1",
      privateKeyPem: "key",
      installationId: 42,
    });
    await expect(provider.verifyInstallation()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("Members 権限のない token を使わない", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ token: "token", permissions: {} }));
    const provider = new GitHubInstallationTokenProvider({
      request: new GitHubRequest(fetcher),
      appId: "1",
      privateKeyPem: "key",
      installationId: 42,
    });
    await expect(provider.getToken()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("token がない応答を失敗にする", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    const provider = new GitHubInstallationTokenProvider({
      request: new GitHubRequest(fetcher),
      appId: "1",
      privateKeyPem: "key",
      installationId: 42,
    });
    await expect(provider.getToken()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
