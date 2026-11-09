import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";
import { describe, expect, it } from "vitest";

import { createWebhookHandler } from "./webhook.js";

import type { DispatchMessage } from "../../message/webhook.js";
import type { LogRecord } from "../../util/logger.js";

const SECRET = "test-secret";

const sign = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const setup = (options: { enqueueFails?: boolean } = {}) => {
  const queued: DispatchMessage[] = [];
  const logs: LogRecord[] = [];
  const handler = createWebhookHandler({
    getWebhookSecret: () => SECRET,
    verifySignature: verifyGitHubWebhookSignature,
    enqueue: (message) => {
      if (options.enqueueFails) return Promise.reject(new Error("queue down"));
      queued.push(message);
      return Promise.resolve();
    },
    logger: { log: (_level, record) => logs.push(record) },
  });
  const send = async (
    event: string,
    payload: unknown,
    overrides: { signature?: string; headers?: Record<string, string> } = {}
  ) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const response = await handler(
      new Request("https://example.com/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": overrides.signature ?? (await sign(body)),
          ...overrides.headers,
        },
        body,
      })
    );
    return response;
  };
  return { queued, send, logs };
};

const push = (overrides: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  before: "b".repeat(40),
  after: "a".repeat(40),
  deleted: false,
  repository: { full_name: "o/r" },
  installation: { id: 5 },
  ...overrides,
});

describe("署名検証", () => {
  it("署名が不正なら 401 を返し、何も enqueue しない", async () => {
    const { send, queued } = setup();

    const response = await send("push", push(), { signature: `sha256=${"0".repeat(64)}` });

    expect(response.status).toBe(401);
    expect(queued).toEqual([]);
  });

  it("署名が不正なら、body が壊れていても parse せず 401 を返す", async () => {
    const { send } = setup();

    const response = await send("push", "{not json", { signature: `sha256=${"0".repeat(64)}` });

    expect(response.status).toBe(401);
  });

  it("必須 header がなければ 400 を返す", async () => {
    const { send, queued } = setup();

    const response = await send("push", push(), { headers: { "x-github-delivery": "" } });

    expect(response.status).toBe(400);
    expect(queued).toEqual([]);
  });

  it("署名が正しくても JSON でなければ 400 を返す", async () => {
    const { send } = setup();

    expect((await send("push", "{not json")).status).toBe(400);
  });
});

describe("event の振り分け", () => {
  it("ping には 200 を返し、enqueue しない", async () => {
    const { send, queued } = setup();

    expect((await send("ping", { zen: "x" })).status).toBe(200);
    expect(queued).toEqual([]);
  });

  it("branch への push を repository、branch、before だけの message にして enqueue する", async () => {
    const { send, queued } = setup();

    const response = await send("push", push({ ref: "refs/heads/feature/x" }));

    expect(response.status).toBe(202);
    expect(queued).toEqual([
      {
        event: "push",
        deliveryId: "delivery-1",
        installation: { owner: "o", id: 5 },
        repository: "o/r",
        branch: "feature/x",
        before: "b".repeat(40),
      },
    ]);
  });

  it("branch を新しく作った push（before がゼロ OID）は before を省く", async () => {
    const { send, queued } = setup();

    await send("push", push({ before: "0".repeat(40) }));

    expect(queued[0]).not.toHaveProperty("before");
  });

  it("管理 branch への push を、その source の sync-target にして enqueue する", async () => {
    const { send, queued } = setup();

    const response = await send("push", push({ ref: "refs/heads/flightdeck-dispatch/a/src" }));

    expect(response.status).toBe(202);
    expect(queued).toEqual([
      {
        event: "sync-target",
        deliveryId: "delivery-1",
        installation: { owner: "o", id: 5 },
        source: "a/src",
        target: "o/r",
      },
    ]);
  });

  it.each([
    ["source を戻せない管理 branch への push", push({ ref: "refs/heads/flightdeck-dispatch/o-r-submodule" })],
    ["管理 branch の削除", push({ ref: "refs/heads/flightdeck-dispatch/a/src", deleted: true })],
    ["branch の削除", push({ deleted: true })],
    ["tag の push", push({ ref: "refs/tags/v1" })],
  ])("%s は無視する", async (_name, payload) => {
    const { send, queued } = setup();

    const response = await send("push", payload);

    expect(response.status).toBe(200);
    expect(queued).toEqual([]);
  });

  it("enqueue に失敗したら、本文を含めずに deliveryId を記録し、再配信できるよう 503 を返す", async () => {
    const { send, logs } = setup({ enqueueFails: true });

    const response = await send("push", push());

    expect(response.status).toBe(503);
    expect(logs).toEqual([{ event: "enqueue_failed", githubEvent: "push", deliveryId: "delivery-1" }]);
  });

  it("署名つきの payload に installation がなければ 400 を返す", async () => {
    const { send, queued } = setup();

    const { installation: _installation, ...withoutInstallation } = push();
    expect((await send("push", withoutInstallation)).status).toBe(400);
    expect(queued).toEqual([]);
  });

  it("push の payload が不正なら 400 を返す", async () => {
    const { send } = setup();

    expect((await send("push", { ref: "refs/heads/main" })).status).toBe(400);
  });

  it("repository.edited の default branch 変更だけを enqueue する", async () => {
    const { send, queued } = setup();

    await send("repository", {
      action: "edited",
      changes: { description: { from: "x" } },
      repository: { full_name: "o/r" },
      installation: { id: 5 },
    });
    await send("repository", {
      action: "renamed",
      changes: { default_branch: { from: "main" } },
      repository: { full_name: "o/r" },
      installation: { id: 5 },
    });
    expect(queued).toEqual([]);

    const response = await send("repository", {
      action: "edited",
      changes: { default_branch: { from: "main" } },
      repository: { full_name: "o/r" },
      installation: { id: 5 },
    });

    expect(response.status).toBe(202);
    expect(queued).toEqual([
      {
        event: "default-branch-changed",
        deliveryId: "delivery-1",
        installation: { owner: "o", id: 5 },
        repository: "o/r",
        previousDefaultBranch: "main",
      },
    ]);
  });

  const pullRequest = (overrides: Record<string, unknown> = {}) => ({
    action: "opened",
    pull_request: {
      head: { ref: "flightdeck-dispatch/a/src", repo: { id: 1 } },
      base: { repo: { id: 1 } },
    },
    repository: { full_name: "o/parent" },
    installation: { id: 5 },
    ...overrides,
  });

  it.each([
    { action: "opened" },
    { action: "reopened" },
    { action: "edited", changes: { base: { ref: { from: "main" } } } },
  ])("管理 branch の PR の $action を、その source の sync-target にして enqueue する", async (overrides) => {
    const { send, queued } = setup();

    const response = await send("pull_request", pullRequest(overrides));

    expect(response.status).toBe(202);
    expect(queued).toEqual([
      {
        event: "sync-target",
        deliveryId: "delivery-1",
        installation: { owner: "o", id: 5 },
        source: "a/src",
        target: "o/parent",
      },
    ]);
  });

  it.each([
    { name: "base 以外の edited", overrides: { action: "edited", changes: { title: { from: "x" } } } },
    { name: "closed", overrides: { action: "closed" } },
    {
      name: "管理 branch でない head",
      overrides: { pull_request: { head: { ref: "feature/x", repo: { id: 1 } }, base: { repo: { id: 1 } } } },
    },
    {
      name: "fork の head",
      overrides: {
        pull_request: { head: { ref: "flightdeck-dispatch/a/src", repo: { id: 2 } }, base: { repo: { id: 1 } } },
      },
    },
    {
      name: "削除された fork の head",
      overrides: {
        pull_request: { head: { ref: "flightdeck-dispatch/a/src", repo: null }, base: { repo: { id: 1 } } },
      },
    },
  ])("PR の event でも $name は無視する", async ({ overrides }) => {
    const { send, queued } = setup();

    expect((await send("pull_request", pullRequest(overrides))).status).toBe(200);
    expect(queued).toEqual([]);
  });

  it("購読していない event は無視する", async () => {
    const { send, queued } = setup();

    expect((await send("installation", {})).status).toBe(200);
    expect(queued).toEqual([]);
  });
});
