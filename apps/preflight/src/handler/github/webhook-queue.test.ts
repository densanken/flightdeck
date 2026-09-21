import { describe, expect, it, vi } from "vitest";

import {
  createQueuedGitHubWebhookHandler,
  parseGitHubWebhookQueueMessage,
  parseQueuedWebhookPayload,
} from "./webhook-queue.js";
import { ConfigurationError } from "../../errors.js";
import { MAX_WEBHOOK_BODY_BYTES } from "../../util/request-body.js";

import type { GitHubWebhookQueueMessage } from "../../message/github-webhook.js";
import type { Logger } from "../../util/logger.js";

const payload = JSON.stringify({
  action: "opened",
  installation: { id: 42 },
  repository: { name: "repo", owner: { login: "owner" } },
  pull_request: {
    number: 7,
    title: "feat: add login",
    head: { sha: "abc123" },
    user: { login: "author", type: "User" },
    assignees: [],
  },
});

const request = (input: { body?: BodyInit; event?: string; contentType?: string; deliveryId?: string | null } = {}) =>
  new Request("https://worker.example.com/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": input.contentType ?? "application/json",
      "X-GitHub-Event": input.event ?? "pull_request",
      ...(input.deliveryId === null ? {} : { "X-GitHub-Delivery": input.deliveryId ?? "delivery-1" }),
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body: input.body ?? payload,
  });

const setup = (overrides: { logger?: Logger; createDeadlineSignal?: () => AbortSignal } = {}) => {
  const enqueueWebhookDelivery = vi.fn<(message: GitHubWebhookQueueMessage) => Promise<void>>().mockResolvedValue();
  const verifySignature = vi.fn().mockResolvedValue(true);
  const getWebhookSecret = vi.fn().mockReturnValue("secret");
  const logger: Logger = overrides.logger ?? { log: vi.fn() };
  const handler = createQueuedGitHubWebhookHandler({
    enqueueWebhookDelivery,
    getWebhookSecret,
    logger,
    verifySignature,
    createDeadlineSignal: overrides.createDeadlineSignal,
  });
  return { enqueueWebhookDelivery, handler, getWebhookSecret, logger, verifySignature };
};

describe("producer の HTTP 境界", () => {
  it("header 不足と JSON 以外の Content-Type を、secret を読む前に 400 で拒否する", async () => {
    const { handler, getWebhookSecret, enqueueWebhookDelivery } = setup();

    expect((await handler(request({ deliveryId: null }))).status).toBe(400);
    expect((await handler(request({ contentType: "text/plain" }))).status).toBe(400);
    expect(getWebhookSecret).not.toHaveBeenCalled();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("charset 付きの JSON Content-Type を受け入れる", async () => {
    const { handler } = setup();

    const response = await handler(request({ contentType: "application/json; charset=utf-8", event: "ping" }));

    expect(response.status).toBe(200);
  });

  it("consumer が受け付けない delivery ID は enqueue しない", async () => {
    const { handler, enqueueWebhookDelivery, verifySignature } = setup();

    expect((await handler(request({ deliveryId: "delivery/1" }))).status).toBe(400);
    expect((await handler(request({ deliveryId: "x".repeat(129) }))).status).toBe(400);
    expect(verifySignature).not.toHaveBeenCalled();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("上限を超える body を署名検証の前に 413 で拒否する", async () => {
    const { handler, enqueueWebhookDelivery, verifySignature } = setup();

    const response = await handler(request({ body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1) }));

    expect(response.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("body 単体が上限内でも Queue の JSON message 上限を超える payload は enqueue しない", async () => {
    const { handler, enqueueWebhookDelivery, verifySignature } = setup();
    const largePayload = JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: { name: "repo", owner: { login: "owner" } },
      pull_request: {
        number: 7,
        title: '"'.repeat(55_000),
        head: { sha: "abc123" },
        user: { login: "author", type: "User" },
        assignees: [],
      },
    });

    expect(new TextEncoder().encode(largePayload).byteLength).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    const response = await handler(request({ body: largePayload }));

    expect(response.status).toBe(413);
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("deadline に達したら停止した body の読み取りを打ち切り 408 を返す", async () => {
    const controller = new AbortController();
    let confirmCancellation: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      confirmCancellation = resolve;
    });
    const { handler, enqueueWebhookDelivery, verifySignature } = setup({
      createDeadlineSignal: () => controller.signal,
    });
    const stalled = request({
      body: new ReadableStream<Uint8Array>({
        cancel() {
          confirmCancellation?.();
        },
      }),
    });

    const pendingResponse = handler(stalled);
    controller.abort();
    const response = await pendingResponse;
    await cancelled;

    expect(response.status).toBe(408);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "REQUEST_TIMEOUT" });
    expect(verifySignature).not.toHaveBeenCalled();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("abort に由来しない body 読み取り失敗は 500 と構造化 log を返し、署名検証へ進めない", async () => {
    const log = vi.fn();
    const { handler, enqueueWebhookDelivery, verifySignature } = setup({ logger: { log } });
    const readError = new Error("stream broken");
    const broken = request({
      body: new ReadableStream<Uint8Array>({
        pull() {
          throw readError;
        },
      }),
    });

    const response = await handler(broken);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(verifySignature).not.toHaveBeenCalled();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith(
      "error",
      expect.objectContaining({
        event: "github_webhook_receive",
        result: "body_read_failed",
        deliveryId: "delivery-1",
        errorCode: "Error",
      })
    );
  });

  it("getWebhookSecret の ConfigurationError は signature_verification_failed に丸めず呼び出し元へ伝播する", async () => {
    // secret 未設定は composition 層が configKey と configReason を付けて処理する設定エラーであり、
    // ここで catch すると診断情報が失われるため、この catch の外側で評価する
    const { handler, getWebhookSecret, verifySignature } = setup();
    const configError = new ConfigurationError("GITHUB_WEBHOOK_SECRET", "missing");
    getWebhookSecret.mockImplementation(() => {
      throw configError;
    });

    await expect(handler(request())).rejects.toBe(configError);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it("署名検証が例外を投げても 500 と構造化 log を返し、enqueue しない", async () => {
    const log = vi.fn();
    const { handler, enqueueWebhookDelivery, verifySignature } = setup({ logger: { log } });
    verifySignature.mockRejectedValue(new Error("crypto failure"));

    const response = await handler(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith(
      "error",
      expect.objectContaining({
        event: "github_webhook_receive",
        result: "signature_verification_failed",
        deliveryId: "delivery-1",
        errorCode: "Error",
      })
    );
  });

  it("ping と対象外の event は payload を parse せずに応答し、enqueue しない", async () => {
    const { handler, enqueueWebhookDelivery } = setup();

    expect((await handler(request({ body: "not-json", event: "ping" }))).status).toBe(200);
    expect((await handler(request({ body: "not-json", event: "issues" }))).status).toBe(202);
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("不正な JSON と項目が欠けた payload は enqueue せず 400 で拒否する", async () => {
    const { handler, enqueueWebhookDelivery } = setup();

    expect((await handler(request({ body: "{" }))).status).toBe(400);
    expect((await handler(request({ body: '{"action":"opened"}' }))).status).toBe(400);
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("署名検証に通っても UTF-8 として不正な body は INVALID_PAYLOAD で拒否する", async () => {
    const { handler, enqueueWebhookDelivery, verifySignature } = setup();

    // 不正な UTF-8 byte 列
    // fatal decoder が throw して INVALID_PAYLOAD になる経路を通す
    const response = await handler(request({ body: new Uint8Array([0xff, 0xfe]) }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INVALID_PAYLOAD" });
    expect(verifySignature).toHaveBeenCalledTimes(1);
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("文字列値の内部に不正な UTF-8 byte を仕込んだ payload も INVALID_PAYLOAD で拒否する", async () => {
    // 構造としては正当な JSON の title 値の内部だけに不正 byte を仕込む
    // fatal:false なら U+FFFD へ置換され JSON.parse も payload 検証も通って enqueue に到達するため、
    // これが 400 かつ未 enqueue であることは decodeBody の fatal:true を守る回帰テストになる
    const { handler, enqueueWebhookDelivery } = setup();
    const [before, after] = payload.replace("feat: add login", "SMUGGLE_HERE").split("SMUGGLE_HERE");
    const body = new Uint8Array([...new TextEncoder().encode(before), 0xff, ...new TextEncoder().encode(after)]);

    const response = await handler(request({ body }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INVALID_PAYLOAD" });
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });
});

describe("queued GitHub webhook handler", () => {
  it("署名と payload を検証してから Queue へ永続化し 202 を返す", async () => {
    const { handler, enqueueWebhookDelivery } = setup();

    const response = await handler(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, result: "queued" });
    expect(enqueueWebhookDelivery).toHaveBeenCalledWith({
      version: 1,
      event: "pull_request",
      deliveryId: "delivery-1",
      body: payload,
    });
  });

  it("署名不正では enqueue せず、Queue 障害では成功応答しない", async () => {
    const invalid = setup();
    invalid.verifySignature.mockResolvedValue(false);
    expect((await invalid.handler(request())).status).toBe(401);
    expect(invalid.enqueueWebhookDelivery).not.toHaveBeenCalled();

    const log = vi.fn();
    const unavailable = setup({ logger: { log } });
    unavailable.enqueueWebhookDelivery.mockRejectedValue(new Error("unavailable"));
    const response = await unavailable.handler(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(log).toHaveBeenLastCalledWith(
      "error",
      expect.objectContaining({
        event: "github_webhook_enqueue",
        result: "queue_publish_failed",
        deliveryId: "delivery-1",
        errorCode: "Error",
      })
    );
  });

  it.each([
    {
      name: "非 Error 値で reject",
      fail: (enqueue: ReturnType<typeof setup>["enqueueWebhookDelivery"]) => enqueue.mockRejectedValue("unavailable"),
      errorCode: "unknown_error",
    },
    {
      name: "同期的に throw",
      fail: (enqueue: ReturnType<typeof setup>["enqueueWebhookDelivery"]) =>
        enqueue.mockImplementation(() => {
          throw new TypeError("unavailable");
        }),
      errorCode: "TypeError",
    },
  ])("Queue port が $name しても 503 と構造化 log を返す", async ({ fail, errorCode }) => {
    const log = vi.fn();
    const unavailable = setup({ logger: { log } });
    fail(unavailable.enqueueWebhookDelivery);

    const response = await unavailable.handler(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(log).toHaveBeenLastCalledWith(
      "error",
      expect.objectContaining({
        event: "github_webhook_enqueue",
        result: "queue_publish_failed",
        deliveryId: "delivery-1",
        errorCode,
      })
    );
  });

  it("secret と body を log へ出さない", async () => {
    const log = vi.fn();
    const { handler } = setup({ logger: { log } });

    await handler(request());

    const logs = JSON.stringify(log.mock.calls);
    expect(logs).not.toContain("secret");
    expect(logs).not.toContain("feat: add login");
  });
});

describe("parseGitHubWebhookQueueMessage", () => {
  const message = (body: string): GitHubWebhookQueueMessage => ({
    version: 1,
    event: "pull_request",
    deliveryId: "delivery-1",
    body,
  });

  it("ASCII body は byte 上限ちょうどまで受け入れ、超過を拒否する", () => {
    expect(parseGitHubWebhookQueueMessage(message("x".repeat(MAX_WEBHOOK_BODY_BYTES)))).not.toBeNull();
    expect(parseGitHubWebhookQueueMessage(message("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1)))).toBeNull();
  });

  it.each([
    { name: "BMP の3-byte文字", unit: "あ", bytesPerUnit: 3 },
    { name: "astral plane の4-byte文字", unit: "😀", bytesPerUnit: 4 },
  ])("$nameを含む body は UTF-8 byte 数で上限を判定する", ({ unit, bytesPerUnit }) => {
    const atLimit = unit.repeat(MAX_WEBHOOK_BODY_BYTES / bytesPerUnit);
    const overLimit = `${atLimit}x`;

    expect(atLimit.length).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    expect(new TextEncoder().encode(atLimit)).toHaveLength(MAX_WEBHOOK_BODY_BYTES);
    expect(parseGitHubWebhookQueueMessage(message(atLimit))).not.toBeNull();
    expect(overLimit.length).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    expect(new TextEncoder().encode(overLimit)).toHaveLength(MAX_WEBHOOK_BODY_BYTES + 1);
    expect(parseGitHubWebhookQueueMessage(message(overLimit))).toBeNull();
  });

  it("body 単体が byte 上限内でも Queue の JSON message 上限を超えれば拒否する", () => {
    const body = '"'.repeat(MAX_WEBHOOK_BODY_BYTES);

    expect(new TextEncoder().encode(body)).toHaveLength(MAX_WEBHOOK_BODY_BYTES);
    expect(parseGitHubWebhookQueueMessage(message(body))).toBeNull();
  });
});

describe("parseQueuedWebhookPayload", () => {
  const message = (body: string): GitHubWebhookQueueMessage => ({
    version: 1,
    event: "pull_request",
    deliveryId: "delivery-1",
    body,
  });

  it("enqueue した body から payload を復元する", () => {
    expect(parseQueuedWebhookPayload(message(payload))).toMatchObject({
      action: "opened",
      installation: { id: 42 },
      pullRequest: { number: 7, head: { sha: "abc123" } },
    });
  });

  it("JSON として不正な body と項目が欠けた payload は null にする", () => {
    expect(parseQueuedWebhookPayload(message("{"))).toBeNull();
    expect(parseQueuedWebhookPayload(message('{"action":"opened"}'))).toBeNull();
  });
});
