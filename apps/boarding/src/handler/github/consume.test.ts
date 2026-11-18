import { describe, expect, it, vi } from "vitest";

import { createMessageConsumer } from "./consume.js";

const logger = { log: vi.fn() };

describe("createMessageConsumer", () => {
  it("評価結果がエラーなら再試行する", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const consume = createMessageConsumer({
      logger,
      createUseCases: () => ({
        publish: { execute: () => Promise.resolve({ status: "error", reason: "API_ERROR" }) },
        fanout: { execute: () => Promise.resolve() },
      }),
    });
    await consume({
      id: "x",
      attempts: 1,
      body: { event: "evaluate", number: 2, installationId: 1, deliveryId: "d" },
      ack,
      retry,
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
  });

  it("権限変更の message を fanout に渡す", async () => {
    const ack = vi.fn();
    const fanout = vi.fn().mockResolvedValue(undefined);
    const body = { event: "permissions-changed", installationId: 1, deliveryId: "d" };
    const consume = createMessageConsumer({
      logger,
      createUseCases: () => ({
        publish: { execute: () => Promise.resolve({ status: "allowed", reason: "AUTHORIZED" }) },
        fanout: { execute: fanout },
      }),
    });
    await consume({ id: "x", attempts: 1, body, ack, retry: vi.fn() });
    expect(fanout).toHaveBeenCalledWith(body);
    expect(ack).toHaveBeenCalledOnce();
  });

  it("不正な message は破棄する", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const createUseCases = vi.fn();
    await createMessageConsumer({ logger, createUseCases })({ id: "x", attempts: 1, body: {}, ack, retry });
    expect(ack).toHaveBeenCalledOnce();
    expect(createUseCases).not.toHaveBeenCalled();
  });
});
