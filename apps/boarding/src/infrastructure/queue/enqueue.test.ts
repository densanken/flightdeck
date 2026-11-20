import { describe, expect, it, vi } from "vitest";

import { createBatchEnqueue } from "./enqueue.js";

import type { BoardingMessage } from "../../message/webhook.js";

const messages = (count: number): BoardingMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    event: "evaluate",
    deliveryId: "delivery",
    installationId: 1,
    number: index + 1,
  }));

const setup = () => {
  const sendBatch = vi
    .fn<Queue<BoardingMessage>["sendBatch"]>()
    .mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });

  return { sendBatch, enqueue: createBatchEnqueue({ sendBatch }) };
};

describe("createBatchEnqueue", () => {
  it.each([
    [100, [100]],
    [101, [100, 1]],
    [1000, Array.from({ length: 10 }, () => 100)],
  ] as const)("%i 件を 100 件以下の batch に分けて順番に送る", async (count, sizes) => {
    const { sendBatch, enqueue } = setup();
    const input = messages(count);

    await enqueue(input);

    const batches = sendBatch.mock.calls.map(([batch]) => [...batch]);
    expect(batches.map((batch) => batch.length)).toEqual(sizes);
    expect(batches.flat().map(({ body }) => body)).toEqual(input);
  });

  it("1001 件は送信前に予算超過として拒否する", async () => {
    const { sendBatch, enqueue } = setup();

    await expect(enqueue(messages(1001))).rejects.toMatchObject({ code: "SUBREQUEST_LIMIT" });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("message がなければ送信しない", async () => {
    const { sendBatch, enqueue } = setup();

    await enqueue([]);

    expect(sendBatch).not.toHaveBeenCalled();
  });
});
