import { createLogger } from "@flightdeck/logger";
import { describe, expect, it, vi } from "vitest";

import { createWebhookHandler } from "./webhook.js";

const payload = {
  installation: { id: 1 },
  repository: { id: 2, full_name: "org/repo" },
  action: "submitted",
  pull_request: { number: 3, head: { ref: "renovate/foo" } },
};
const request = (event: string, body: unknown) =>
  new Request("https://example.com/webhooks/github", {
    method: "POST",
    headers: { "x-github-event": event, "x-github-delivery": "d", "x-hub-signature-256": "signature" },
    body: JSON.stringify(body),
  });
const setup = (verified = true, cached = false) => {
  const execute = vi.fn().mockResolvedValue(undefined);
  const waitUntil = vi.fn();
  // 実装と同じく、branch がなければ期限内とは答えない
  const has = vi.fn((_: number, branches: readonly string[]) => Promise.resolve(cached && branches.length > 0));
  const handler = createWebhookHandler({
    getWebhookSecret: () => "secret",
    verifySignature: () => Promise.resolve(verified),
    skipCache: { has, remember: vi.fn() },
    createUseCase: () => ({ execute }),
    waitUntil,
    logger: createLogger("error"),
  });
  return { handler, execute, waitUntil, has };
};

describe("Webhook", () => {
  it("署名が無効なら受け付けない", async () => {
    const { handler, waitUntil } = setup(false);
    expect((await handler(request("pull_request_review", payload))).status).toBe(401);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("レビュー提出を受け取り処理を waitUntil に渡す", async () => {
    const { handler, execute, waitUntil } = setup();
    expect((await handler(request("pull_request_review", payload))).status).toBe(202);
    await waitUntil.mock.calls[0]?.[0];
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "pull_request", number: 3, repositoryId: 2 }));
  });

  it("対象イベントの不正な payload を拒否する", async () => {
    const { handler, waitUntil } = setup();
    expect(
      (await handler(request("pull_request_review", { ...payload, pull_request: { head: { ref: "renovate/foo" } } })))
        .status
    ).toBe(400);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("安全な整数の範囲を超える ID を拒否する", async () => {
    const { handler, waitUntil } = setup();
    const invalid = { ...payload, installation: { id: Number.MAX_SAFE_INTEGER + 1 } };

    expect((await handler(request("pull_request_review", invalid))).status).toBe(400);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("購読対象外のイベントを無視する", async () => {
    const { handler, waitUntil } = setup();
    expect((await handler(request("pull_request", payload))).status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("完了した check suite の対象 PR と SHA を渡す", async () => {
    const { handler, execute, waitUntil } = setup();
    const body = {
      installation: payload.installation,
      repository: payload.repository,
      action: "completed",
      check_suite: { head_sha: "a".repeat(40), head_branch: "renovate/foo", pull_requests: [{ number: 3 }] },
    };
    expect((await handler(request("check_suite", body))).status).toBe(202);
    await waitUntil.mock.calls[0]?.[0];
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "commit", sha: "a".repeat(40), numbers: [3] })
    );
  });

  it("PR がない check suite は numbers なしの commit 入力で処理する", async () => {
    const { handler, execute, waitUntil } = setup();
    const body = {
      installation: payload.installation,
      repository: payload.repository,
      action: "completed",
      check_suite: { head_sha: "a".repeat(40), head_branch: null, pull_requests: [] },
    };
    expect((await handler(request("check_suite", body))).status).toBe(202);
    await waitUntil.mock.calls[0]?.[0];
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "commit", sha: "a".repeat(40) }));
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("numbers");
  });

  it("status を action なしで処理する", async () => {
    const { handler, execute, waitUntil } = setup();
    expect(
      (
        await handler(
          request("status", {
            installation: payload.installation,
            repository: payload.repository,
            sha: "a".repeat(40),
            branches: [{ name: "flightdeck-dispatch/a/b" }],
          })
        )
      ).status
    ).toBe(202);
    await waitUntil.mock.calls[0]?.[0];
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "commit", sha: "a".repeat(40) }));
  });

  it("対象外の branch の webhook は、評価せずに見送る", async () => {
    const { handler, waitUntil } = setup();
    const common = { installation: payload.installation, repository: payload.repository };
    const sha = "a".repeat(40);

    const responses = await Promise.all([
      handler(request("pull_request_review", { ...payload, pull_request: { number: 3, head: { ref: "feature/x" } } })),
      handler(
        request("check_suite", {
          ...common,
          action: "completed",
          check_suite: { head_sha: sha, head_branch: "feature/x", pull_requests: [] },
        })
      ),
      handler(request("status", { ...common, sha, branches: [{ name: "main" }] })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("branches が空の status は、取りこぼしを避けて評価する", async () => {
    const { handler, waitUntil } = setup();
    const body = {
      installation: payload.installation,
      repository: payload.repository,
      sha: "a".repeat(40),
      branches: [],
    };

    expect((await handler(request("status", body))).status).toBe(202);
    expect(waitUntil).toHaveBeenCalled();
  });

  it("見送りの期限内の branch は、認証の前に見送る", async () => {
    const { handler, waitUntil, has } = setup(true, true);
    const body = {
      installation: payload.installation,
      repository: payload.repository,
      sha: "a".repeat(40),
      branches: [{ name: "main" }, { name: "renovate/foo" }],
    };

    expect((await handler(request("status", body))).status).toBe(200);
    expect(has).toHaveBeenCalledWith(2, ["renovate/foo"]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("レビューは、見送りの期限内の branch でも評価する", async () => {
    const { handler, waitUntil, has } = setup(true, true);

    expect((await handler(request("pull_request_review", payload))).status).toBe(202);
    expect(has).toHaveBeenCalledWith(2, []);
    expect(waitUntil).toHaveBeenCalled();
  });
});
