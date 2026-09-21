import { raceWithSignal } from "./timeout.js";

// Cloudflare Queues の 128 KB message 上限に metadata 分の余裕を残す
export const MAX_WEBHOOK_BODY_BYTES = 120_000;

export type WebhookBodyResult = { status: "ok"; body: Uint8Array } | { status: "too_large" } | { status: "timed_out" };

export const readWebhookBody = async (request: Request, signal: AbortSignal): Promise<WebhookBodyResult> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_WEBHOOK_BODY_BYTES) {
    return { status: "too_large" };
  }
  if (!request.body) return { status: "ok", body: new Uint8Array() };

  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    for (;;) {
      const { done, value } = await raceWithSignal(reader.read(), signal);
      if (done) break;
      totalLength += value.byteLength;
      if (totalLength > MAX_WEBHOOK_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { status: "too_large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    void reader.cancel().catch(() => undefined);
    return { status: "timed_out" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // timeout 後は stream の cancel 完了まで read が pending のまま残る場合がある
    }
  }

  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", body };
};
