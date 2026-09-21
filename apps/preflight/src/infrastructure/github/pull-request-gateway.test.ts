import { describe, expect, it, vi } from "vitest";

import { GitHubInstallationSession } from "./installation-session.js";
import { GitHubPullRequestGatewayImpl } from "./pull-request-gateway.js";
import { RecordingLogger } from "../../test-helper/platform.js";

import type { GitHubInstallationSessionOptions } from "./installation-session.js";

type CreateAppJwt = NonNullable<GitHubInstallationSessionOptions["createAppJwt"]>;
type CreateInstallationToken = NonNullable<GitHubInstallationSessionOptions["createInstallationToken"]>;

describe("GitHubPullRequestGatewayImpl", () => {
  it("soft deadline で abort したあとも、取得済みの installation token を fail-closed status で再利用する", async () => {
    const createAppJwt = vi.fn<CreateAppJwt>().mockResolvedValue("app-jwt");
    const createInstallationToken = vi.fn<CreateInstallationToken>().mockResolvedValue("installation-token");
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}", { status: 201 })));
    const session = new GitHubInstallationSession({
      installationId: 42,
      getCredentials: () => ({ appId: "12345", privateKeyPem: "private-key" }),
      fetchImpl,
      createAppJwt,
      createInstallationToken,
    });
    const gateway = new GitHubPullRequestGatewayImpl(session, new RecordingLogger(), "delivery-1", fetchImpl);
    await session.getInstallationToken(new AbortController().signal);
    const softController = new AbortController();
    const timeoutReason = new Error("soft deadline");
    softController.abort(timeoutReason);
    await expect(session.getInstallationToken(softController.signal)).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
      statusCode: 504,
      cause: timeoutReason,
    });

    await gateway.setTitleStatus(
      {
        owner: "owner",
        repo: "repo",
        sha: "abc123",
        state: "error",
        description: "検証に失敗しました",
      },
      new AbortController().signal
    );

    expect(createInstallationToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/repos/owner/repo/statuses/abc123");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer installation-token");
    // targetUrl を渡していないので target_url は body に載らない
    expect(JSON.parse(init?.body as string)).toEqual({
      state: "error",
      description: "検証に失敗しました",
      context: "PR Title",
    });
  });
});
