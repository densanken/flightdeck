import { parsePullRequestWebhookPayload } from "./payload.js";
import { jsonResponse, requestError } from "../../util/http-response.js";
import { MAX_WEBHOOK_BODY_BYTES, readWebhookBody } from "../../util/request-body.js";

import type { PullRequestWebhookPayload } from "./payload.js";
import type { ErrorCode } from "../../errors.js";
import type { GitHubWebhookQueueMessage } from "../../message/github-webhook.js";
import type { Logger } from "../../util/logger.js";
import type { WebhookBodyResult } from "../../util/request-body.js";

export interface QueuedGitHubWebhookHandlerDependencies {
  enqueueWebhookDelivery: (message: GitHubWebhookQueueMessage) => Promise<void>;
  getWebhookSecret: () => string;
  logger: Logger;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  createDeadlineSignal?: () => AbortSignal;
}

const DEADLINE_MS = 8_500;
const MAX_EVENT_NAME_LENGTH = 64;
const MAX_DELIVERY_ID_LENGTH = 128;
const MAX_SIGNATURE_HEADER_LENGTH = 128;
// Queue の既定 JSON serialization では、body 内の引用符などが再度 escape される
const MAX_QUEUE_MESSAGE_BYTES = 128 * 1024 - 1;
const textEncoder = new TextEncoder();

// consumer が Queue message を parse するときと同じ形
// ここで通すと consumer が捨てる delivery を防ぐ
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const boundedHeader = (value: string | null, maximumLength: number): string | null => {
  const normalized = value?.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
};

const deliveryIdHeader = (value: string | null): string | null => {
  const normalized = boundedHeader(value, MAX_DELIVERY_ID_LENGTH);
  return normalized !== null && DELIVERY_ID_PATTERN.test(normalized) ? normalized : null;
};

const hasJsonContentType = (request: Request): boolean =>
  request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";

const decodeBody = (rawBody: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody);

export const createQueuedGitHubWebhookHandler =
  (dependencies: QueuedGitHubWebhookHandlerDependencies) =>
  async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    const githubEvent = boundedHeader(request.headers.get("x-github-event"), MAX_EVENT_NAME_LENGTH);
    const deliveryId = deliveryIdHeader(request.headers.get("x-github-delivery"));
    const signature = boundedHeader(request.headers.get("x-hub-signature-256"), MAX_SIGNATURE_HEADER_LENGTH);
    if (!hasJsonContentType(request) || !githubEvent || !deliveryId || !signature) {
      return requestError("INVALID_REQUEST");
    }

    const signal = AbortSignal.any([
      request.signal,
      dependencies.createDeadlineSignal?.() ?? AbortSignal.timeout(DEADLINE_MS),
    ]);
    let bodyResult: WebhookBodyResult;
    try {
      bodyResult = await readWebhookBody(request, signal);
    } catch (error) {
      // deadline による abort は readWebhookBody が timed_out として返すため、ここに届くのは想定外の stream 障害だけ
      dependencies.logger.log("error", {
        event: "github_webhook_receive",
        result: "body_read_failed",
        githubEvent,
        deliveryId,
        durationMs: Date.now() - startedAt,
        errorCode: error instanceof Error ? error.name : "unknown_error",
      });
      return jsonResponse({ ok: false, code: "INTERNAL_ERROR" satisfies ErrorCode }, 500);
    }
    if (bodyResult.status === "too_large") return requestError("INVALID_REQUEST", 413);
    if (bodyResult.status === "timed_out") {
      dependencies.logger.log("warn", { event: "github_webhook_receive", result: "request_timeout", deliveryId });
      return jsonResponse({ ok: false, code: "REQUEST_TIMEOUT" satisfies ErrorCode }, 408);
    }

    // secret 未設定の ConfigurationError は try の外で評価し、composition 層の設定エラー処理へそのまま伝播させる
    const webhookSecret = dependencies.getWebhookSecret();
    let signatureValid: boolean;
    try {
      signatureValid = await dependencies.verifySignature({
        rawBody: bodyResult.body,
        signatureHeader: signature,
        secret: webhookSecret,
      });
    } catch (error) {
      dependencies.logger.log("error", {
        event: "github_webhook_receive",
        result: "signature_verification_failed",
        githubEvent,
        deliveryId,
        durationMs: Date.now() - startedAt,
        errorCode: error instanceof Error ? error.name : "unknown_error",
      });
      return jsonResponse({ ok: false, code: "INTERNAL_ERROR" satisfies ErrorCode }, 500);
    }
    if (!signatureValid) {
      dependencies.logger.log("warn", {
        event: "github_webhook_receive",
        result: "invalid_signature",
        githubEvent,
        deliveryId,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse({ ok: false, code: "INVALID_SIGNATURE" satisfies ErrorCode }, 401);
    }

    if (githubEvent === "ping") return jsonResponse({ ok: true, result: "ping" }, 200);
    if (githubEvent !== "pull_request") return jsonResponse({ ok: true, result: "ignored_event" }, 202);

    let body: string;
    let parsedBody: unknown;
    try {
      body = decodeBody(bodyResult.body);
      parsedBody = JSON.parse(body) as unknown;
    } catch {
      return requestError("INVALID_PAYLOAD");
    }
    // consumer が捨てる payload を queue へ入れないよう、shape をここで確定させる
    if (!parsePullRequestWebhookPayload(parsedBody)) return requestError("INVALID_PAYLOAD");

    const message = parseGitHubWebhookQueueMessage({ version: 1, event: "pull_request", deliveryId, body });
    if (message === null) return requestError("INVALID_REQUEST", 413);

    try {
      await dependencies.enqueueWebhookDelivery(message);
      dependencies.logger.log("info", {
        event: "github_webhook_enqueue",
        result: "queued",
        githubEvent,
        deliveryId,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse({ ok: true, result: "queued" }, 202);
    } catch (error) {
      dependencies.logger.log("error", {
        event: "github_webhook_enqueue",
        result: "queue_publish_failed",
        githubEvent,
        deliveryId,
        durationMs: Date.now() - startedAt,
        errorCode: error instanceof Error ? error.name : "unknown_error",
      });
      return jsonResponse({ ok: false, code: "INTERNAL_ERROR" satisfies ErrorCode }, 503);
    }
  };

export const parseGitHubWebhookQueueMessage = (value: unknown): GitHubWebhookQueueMessage | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.event !== "pull_request") return null;
  if (typeof record.deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(record.deliveryId)) return null;
  if (typeof record.body !== "string" || textEncoder.encode(record.body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return null;
  }
  const message: GitHubWebhookQueueMessage = {
    version: 1,
    event: "pull_request",
    deliveryId: record.deliveryId,
    body: record.body,
  };
  if (textEncoder.encode(JSON.stringify(message)).byteLength > MAX_QUEUE_MESSAGE_BYTES) return null;
  return message;
};

/**
 * Queue message の body から payload を復元する
 * 署名は enqueue 前に検証済みで、message は Queue 経由でしか届かないため consumer では再検証しない
 */
export const parseQueuedWebhookPayload = (message: GitHubWebhookQueueMessage): PullRequestWebhookPayload | null => {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(message.body) as unknown;
  } catch {
    return null;
  }
  return parsePullRequestWebhookPayload(parsedBody);
};
