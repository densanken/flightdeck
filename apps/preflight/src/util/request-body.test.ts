import { describe, expect, it } from "vitest";

import { MAX_WEBHOOK_BODY_BYTES, readWebhookBody } from "./request-body.js";

const CHUNK = MAX_WEBHOOK_BODY_BYTES / 2;

// Content-Length を持たない stream body を作り、累積上限ガードの経路を通す
const streamRequest = (chunks: Uint8Array[], onCancel?: () => void): Request => {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request("https://worker.example.com/webhooks/github", { method: "POST", body });
};

const filled = (length: number, value: number): Uint8Array => new Uint8Array(length).fill(value);

describe("readWebhookBody", () => {
  it("累積 chunk が上限を超えたら reader を cancel して too_large を返す", async () => {
    let cancelled = false;
    // 2 チャンクでちょうど MAX、3 チャンク目の 1 byte で MAX+1 に到達させる
    const request = streamRequest([filled(CHUNK, 0xaa), filled(CHUNK, 0xbb), filled(1, 0xcc)], () => {
      cancelled = true;
    });

    const result = await readWebhookBody(request, new AbortController().signal);
    await Promise.resolve();

    expect(result).toEqual({ status: "too_large" });
    expect(cancelled).toBe(true);
  });

  it("ちょうど上限の body を受け入れ、chunk を順番どおり連結する", async () => {
    const request = streamRequest([filled(CHUNK, 0xaa), filled(CHUNK, 0xbb)]);

    const result = await readWebhookBody(request, new AbortController().signal);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.body.byteLength).toBe(MAX_WEBHOOK_BODY_BYTES);
    expect(result.body[0]).toBe(0xaa);
    expect(result.body[CHUNK - 1]).toBe(0xaa);
    expect(result.body[CHUNK]).toBe(0xbb);
    expect(result.body[MAX_WEBHOOK_BODY_BYTES - 1]).toBe(0xbb);
  });

  it("signal の abort に由来しない stream エラーはそのまま再送出する", async () => {
    const readError = new Error("stream broken");
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw readError;
      },
    });
    const request = new Request("https://worker.example.com/webhooks/github", { method: "POST", body });

    await expect(readWebhookBody(request, new AbortController().signal)).rejects.toBe(readError);
  });

  it("body のない request は空の ok として扱う", async () => {
    const request = new Request("https://worker.example.com/webhooks/github", { method: "POST" });

    const result = await readWebhookBody(request, new AbortController().signal);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.body.byteLength).toBe(0);
  });
});
