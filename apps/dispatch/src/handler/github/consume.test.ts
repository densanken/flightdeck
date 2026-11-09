import { describe, expect, it } from "vitest";

import { createMessageConsumer } from "./consume.js";
import { DispatchError } from "../../errors.js";

import type { SyncUseCase } from "../../usecase/sync/interface.js";
import type { LogRecord } from "../../util/logger.js";

const unexpected = () => Promise.reject(new Error("unexpected call"));

const setup = (overrides: Partial<SyncUseCase>) => {
  const created: unknown[] = [];
  const useCase: SyncUseCase = {
    handlePush: unexpected,
    handleDefaultBranchChanged: unexpected,
    syncTarget: unexpected,
    closeTarget: unexpected,
    ...overrides,
  };
  const logs: LogRecord[] = [];
  const result = { acked: 0, retried: [] as unknown[] };
  const consume = createMessageConsumer({
    createUseCase: (eventInstallation) => {
      created.push(eventInstallation);
      return useCase;
    },
    logger: { log: (_level, record) => logs.push(record) },
  });
  const run = (body: unknown, attempts = 1) =>
    consume({
      id: "m1",
      body,
      attempts,
      ack: () => (result.acked += 1),
      retry: (options) => result.retried.push(options),
    });
  return { logs, result, run, created };
};

const pushMessage = {
  event: "push",
  deliveryId: "d",
  installation: { owner: "o", id: 5 },
  repository: "o/r",
  branch: "main",
  before: "0".repeat(40),
};

describe("createMessageConsumer", () => {
  it("push message を use case へ渡して ack する", async () => {
    const calls: unknown[] = [];
    const { run, result, created } = setup({
      handlePush: (input) => {
        calls.push(input);
        return Promise.resolve();
      },
    });

    await run(pushMessage);

    expect(calls).toMatchObject([{ repository: "o/r", branch: "main", before: "0".repeat(40) }]);
    expect(result.acked).toBe(1);
    // event の repository は、Webhook が運んだ Installation の ID で認証する
    expect(created).toMatchObject([{ installation: { owner: "o", id: 5 } }]);
  });

  it("default branch 変更の message を use case へ渡す", async () => {
    const calls: unknown[] = [];
    const { run } = setup({
      handleDefaultBranchChanged: (input) => {
        calls.push(input);
        return Promise.resolve();
      },
    });

    await run({
      event: "default-branch-changed",
      deliveryId: "d",
      installation: { owner: "o", id: 5 },
      repository: "o/r",
      previousDefaultBranch: "main",
    });

    expect(calls).toMatchObject([{ repository: "o/r", previousDefaultBranch: "main" }]);
  });

  it("子 message（target の同期と Close）を、それぞれの use case へ渡す", async () => {
    const calls: unknown[] = [];
    const record = (name: string) => (input: unknown) => {
      calls.push([name, input]);
      return Promise.resolve();
    };
    const { run, created } = setup({ syncTarget: record("syncTarget"), closeTarget: record("closeTarget") });
    const base = { deliveryId: "d", installation: { owner: "o", id: 5 } };

    await run({ ...base, event: "sync-target", source: "o/src", target: "o/parent" });
    await run({ ...base, event: "close-target", source: "o/src", target: "o/old" });

    expect(calls).toMatchObject([
      ["syncTarget", { source: "o/src", target: "o/parent" }],
      ["closeTarget", { source: "o/src", target: "o/old" }],
    ]);
    // どの message も、運ばれた Installation で認証する
    expect(created).toMatchObject([{ installation: { owner: "o", id: 5 } }, { installation: { owner: "o", id: 5 } }]);
  });

  it("形が壊れた message は retry せず ack する", async () => {
    const { run, result } = setup({});

    await run({ event: "push" });

    expect(result).toEqual({ acked: 1, retried: [] });
  });

  it("retryable な失敗は Retry-After の秒数で retry する", async () => {
    const { run, result } = setup({
      handlePush: () => Promise.reject(new DispatchError("retryable", "limited", { retryAfterSeconds: 42 })),
    });

    await run(pushMessage);

    expect(result).toEqual({ acked: 0, retried: [{ delaySeconds: 42 }] });
  });

  it("想定外の例外は retry する", async () => {
    const { run, result } = setup({ handlePush: () => Promise.reject(new Error("boom")) });

    await run(pushMessage);

    expect(result.retried).toHaveLength(1);
  });

  it("恒久的な失敗は retry せず ack する", async () => {
    const { run, result } = setup({ handlePush: () => Promise.reject(new DispatchError("permission", "denied")) });

    await run(pushMessage);

    expect(result).toEqual({ acked: 1, retried: [] });
  });

  it("ログに message の種類と repository を載せる（Webhook の本文は載せない）", async () => {
    const { run, logs } = setup({ handlePush: () => Promise.resolve() });

    await run(pushMessage);

    expect(logs).toEqual([
      {
        event: "consume",
        messageEvent: "push",
        repository: "o/r",
        deliveryId: "d",
        messageId: "m1",
        attempts: 1,
        result: "processed",
      },
    ]);
  });

  it("再実行の回数を使い切った失敗は error として記録し、それ以前は warn の retry とする", async () => {
    const levels: string[] = [];
    const results: unknown[] = [];
    const consume = createMessageConsumer({
      createUseCase: () => ({
        handlePush: () => Promise.reject(new Error("boom")),
        handleDefaultBranchChanged: unexpected,
        syncTarget: unexpected,
        closeTarget: unexpected,
      }),
      logger: {
        log: (level, record) => {
          levels.push(level);
          results.push(record.result);
        },
      },
    });
    const message = (attempts: number) => ({
      id: "m",
      body: pushMessage,
      attempts,
      ack: () => undefined,
      retry: () => undefined,
    });

    await consume(message(5));
    await consume(message(6));

    expect(levels).toEqual(["warn", "error"]);
    expect(results).toEqual(["retry", "exhausted"]);
  });
});
