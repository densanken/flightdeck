import { createLogger } from "@flightdeck/logger";
import { describe, expect, it, vi } from "vitest";

import { createWebhookHandler } from "./webhook.js";

const payload = {
  installation: { id: 1 },
  repository: { id: 2, full_name: "org/repo" },
  action: "submitted",
  pull_request: { number: 3 },
};
const request = (event: string, body: unknown) =>
  new Request("https://example.com/webhooks/github", {
    method: "POST",
    headers: { "x-github-event": event, "x-github-delivery": "d", "x-hub-signature-256": "signature" },
    body: JSON.stringify(body),
  });
const setup = (verified = true) => {
  const execute = vi.fn().mockResolvedValue(undefined);
  const waitUntil = vi.fn();
  const handler = createWebhookHandler({
    getWebhookSecret: () => "secret",
    verifySignature: () => Promise.resolve(verified),
    createUseCase: () => ({ execute }),
    waitUntil,
    logger: createLogger("error"),
  });
  return { handler, execute, waitUntil };
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
    expect((await handler(request("pull_request_review", { ...payload, pull_request: {} }))).status).toBe(400);
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
      check_suite: { head_sha: "a".repeat(40), pull_requests: [{ number: 3 }] },
    };
    expect((await handler(request("check_suite", body))).status).toBe(202);
    await waitUntil.mock.calls[0]?.[0];
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "commit", sha: "a".repeat(40), numbers: [3] })
    );
  });

  it("status を action なしで処理する", async () => {
    const { handler, execute, waitUntil } = setup();
    expect(
      (
        await handler(
          request("status", { installation: payload.installation, repository: payload.repository, sha: "a".repeat(40) })
        )
      ).status
    ).toBe(202);
    await waitUntil.mock.calls[0]?.[0];
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "commit", sha: "a".repeat(40) }));
  });
});
