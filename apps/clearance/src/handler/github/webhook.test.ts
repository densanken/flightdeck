import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";
import { createLogger } from "@flightdeck/logger";
import { describe, expect, it, vi } from "vitest";

import { createWebhookHandler } from "./webhook.js";
import { ConfigurationError } from "../../errors.js";

const base = { installation: { id: 1 }, repository: { id: 2, full_name: "org/repo" }, sender: { id: 5 } };
const secret = "test-secret";

const sign = async (body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const setup = (options: { createFailure?: Error } = {}) => {
  const reviewPullRequests = vi.fn(() => Promise.resolve());
  const reviewCommit = vi.fn(() => Promise.resolve());
  const waitUntil = vi.fn();
  const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const logger = createLogger("info", sink);
  const handler = createWebhookHandler({
    getWebhookSecret: () => secret,
    getBotUserId: () => 3,
    verifySignature: verifyGitHubWebhookSignature,
    waitUntil,
    createUseCase: () => {
      if (options.createFailure) throw options.createFailure;
      return { reviewPullRequests, reviewCommit };
    },
    logger,
  });

  const send = async (event: string, payload: unknown, signature?: string) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const request = new Request("https://example.com/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": signature ?? (await sign(body)),
      },
      body,
    });

    return handler(request);
  };

  return { reviewPullRequests, reviewCommit, waitUntil, send, sink };
};

describe("Webhook の振り分け", () => {
  it("指定された PR イベントだけ探索し、本文の編集では Dismiss だけを行う", async () => {
    const { send, reviewPullRequests } = setup();

    for (const action of ["opened", "synchronize", "reopened", "ready_for_review", "closed", "edited"]) {
      expect((await send("pull_request", { ...base, action, number: 1 })).status).toBe(202);
      expect(reviewPullRequests).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sweep: action !== "edited",
          numbers: action === "closed" ? [] : [1],
          dismissOnly: action === "edited",
        })
      );
    }
  });

  it("レビューと PR コメントを振り分け自身が送ったレビューを無視する", async () => {
    const { send, reviewPullRequests } = setup();
    const review = { ...base, action: "submitted", pull_request: { number: 4 } };

    expect((await send("pull_request_review", review)).status).toBe(202);
    expect((await send("pull_request_review", { ...review, action: "dismissed" })).status).toBe(202);
    expect((await send("pull_request_review", { ...review, sender: { id: 3 } })).status).toBe(200);
    expect(
      (await send("issue_comment", { ...base, action: "edited", issue: { number: 9, pull_request: {} } })).status
    ).toBe(202);
    expect(reviewPullRequests).toHaveBeenLastCalledWith(expect.objectContaining({ numbers: [9] }));
    expect((await send("issue_comment", { ...base, action: "created", issue: { number: 9 } })).status).toBe(200);
  });

  it("check suite の PR と SHA を渡し、不正な payload と未知の event を区別する", async () => {
    const { send, reviewCommit } = setup();
    const sha = "a".repeat(40);

    expect(
      (
        await send("check_suite", {
          ...base,
          action: "completed",
          check_suite: { head_sha: sha, pull_requests: [{ number: 6 }] },
        })
      ).status
    ).toBe(202);
    expect(reviewCommit).toHaveBeenCalledWith(expect.objectContaining({ numbers: [6], sha }));

    const invalid = await send("status", base);

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
    expect((await send("unknown", {})).status).toBe(200);
  });
});

describe("Webhook の受信", () => {
  it("署名が不正なら JSON を解析せず 401 を返す", async () => {
    const { send, reviewPullRequests, waitUntil } = setup();

    expect((await send("pull_request", "{invalid", `sha256=${"0".repeat(64)}`)).status).toBe(401);
    expect(reviewPullRequests).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("ping を受け付け、処理を起動しない", async () => {
    const { send, reviewPullRequests, waitUntil } = setup();

    expect((await send("ping", {})).status).toBe(200);
    expect(reviewPullRequests).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("署名が正しくても JSON が不正なら 400 を返す", async () => {
    const { send, reviewPullRequests } = setup();

    expect((await send("pull_request", "{invalid")).status).toBe(400);
    expect(reviewPullRequests).not.toHaveBeenCalled();
  });

  it("人間によるレビューの dismissed を受け付け waitUntil で再評価する", async () => {
    const { send, reviewPullRequests, waitUntil } = setup();

    const response = await send("pull_request_review", { ...base, action: "dismissed", pull_request: { number: 4 } });

    expect(response.status).toBe(202);
    expect(reviewPullRequests).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      installationId: 1,
      repository: "org/repo",
      repositoryId: 2,
      numbers: [4],
      sweep: false,
      dismissOnly: false,
    });
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("status では commit に関連する PR を評価する", async () => {
    const { send, reviewPullRequests, reviewCommit, waitUntil } = setup();
    const sha = "a".repeat(40);

    expect((await send("status", { ...base, sha })).status).toBe(202);
    expect(reviewCommit).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      installationId: 1,
      repositoryId: 2,
      repository: "org/repo",
      sha,
    });
    expect(reviewPullRequests).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("PR がない check suite は処理を起動せず 200 を返す", async () => {
    const { send, reviewPullRequests, waitUntil } = setup();

    const response = await send("check_suite", {
      ...base,
      action: "completed",
      check_suite: { head_sha: "a".repeat(40), pull_requests: [] },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(reviewPullRequests).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("usecase を組み立てられない設定の不備を configuration_error として記録する", async () => {
    const { send, waitUntil, sink } = setup({ createFailure: new ConfigurationError("missing") });

    expect((await send("pull_request", { ...base, action: "opened", number: 4 })).status).toBe(202);

    await waitUntil.mock.calls[0]?.[0];

    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"configuration_error"'));
  });
});
