import { describe, expect, it, vi } from "vitest";

import { isAbortError, raceWithSignal, throwIfAborted } from "./timeout.js";

describe("isAbortError", () => {
  it("abort() が投げる AbortError を中断として扱う", () => {
    expect(isAbortError(new DOMException("operation aborted", "AbortError"))).toBe(true);
  });

  it("AbortSignal.timeout() が投げる TimeoutError を中断として扱う", () => {
    expect(isAbortError(new DOMException("deadline exceeded", "TimeoutError"))).toBe(true);
  });

  it("中断以外の Error は中断として扱わない", () => {
    expect(isAbortError(new TypeError("network"))).toBe(false);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
  });

  it("Error でない値は name が中断と同じでも中断として扱わない", () => {
    expect(isAbortError({ name: "TimeoutError" })).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("raceWithSignal", () => {
  // EventTarget は登録中の listener を公開しないため、signal ごとに abort listener の登録と解除の回数を数える
  const listenerTrackedSignal = () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    return {
      controller,
      signal: controller.signal,
      listenerCounts: () => ({
        added: addEventListener.mock.calls.length,
        removed: removeEventListener.mock.calls.length,
      }),
      addOptions: () => addEventListener.mock.calls.map((call) => call[2]),
    };
  };

  it("abort されなければ operation の解決値をそのまま返す", async () => {
    await expect(raceWithSignal(Promise.resolve("value"), new AbortController().signal)).resolves.toBe("value");
  });

  it("abort 済みの signal では operation を待たずに reason を投げる", async () => {
    const controller = new AbortController();
    const timeoutReason = new DOMException("deadline exceeded", "TimeoutError");
    controller.abort(timeoutReason);

    await expect(raceWithSignal(new Promise<string>(() => undefined), controller.signal)).rejects.toBe(timeoutReason);
  });

  it("待機中に abort された pending な operation を reason で中断する", async () => {
    const controller = new AbortController();
    const timeoutReason = new DOMException("deadline exceeded", "TimeoutError");

    const result = raceWithSignal(new Promise<string>(() => undefined), controller.signal);
    controller.abort(timeoutReason);

    await expect(result).rejects.toBe(timeoutReason);
  });

  it("Error でない abort reason は中断を示す Error へ置き換える", async () => {
    const controller = new AbortController();
    controller.abort("deadline marker");

    await expect(raceWithSignal(new Promise<string>(() => undefined), controller.signal)).rejects.toThrow(
      "Operation aborted"
    );
  });

  it("operation の非 Error な reject は cause に元の値を残した Error へ包む", async () => {
    const operation = Promise.withResolvers<string>();
    const result = raceWithSignal(operation.promise, new AbortController().signal);
    operation.reject("failure marker");

    // toMatchObject は prototype を見ないため、Error へ包んでいることを別に固定する
    await expect(result).rejects.toThrow(Error);
    await expect(result).rejects.toMatchObject({
      message: "Operation failed",
      cause: "failure marker",
    });
  });

  // 同一の deadline signal を request、retry の待機、body 読取で共有するため、解除が漏れると listener が単調増加する
  it("operation の解決後に abort listener を解除する", async () => {
    const tracked = listenerTrackedSignal();
    const operation = Promise.withResolvers<string>();

    const result = raceWithSignal(operation.promise, tracked.signal);
    operation.resolve("value");

    await expect(result).resolves.toBe("value");
    expect(tracked.listenerCounts()).toEqual({ added: 1, removed: 1 });
  });

  it("operation の reject 後にも abort listener を解除する", async () => {
    const tracked = listenerTrackedSignal();
    const operation = Promise.withResolvers<string>();

    const result = raceWithSignal(operation.promise, tracked.signal);
    operation.reject(new Error("failure marker"));

    await expect(result).rejects.toThrow("failure marker");
    expect(tracked.listenerCounts()).toEqual({ added: 1, removed: 1 });
  });

  // abort 後に operation が決着しないと解除の経路を通らないため、登録側の once で listener を残さない
  it("abort listener を once で登録する", async () => {
    const tracked = listenerTrackedSignal();

    const result = raceWithSignal(new Promise<string>(() => undefined), tracked.signal);
    tracked.controller.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(result).rejects.toThrow("deadline exceeded");
    expect(tracked.addOptions()).toEqual([{ once: true }]);
  });
});

describe("throwIfAborted", () => {
  it("abort されていない signal では解決する", async () => {
    await expect(throwIfAborted(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("呼び出し直後に同期的に abort() されても中断として検出する", async () => {
    const controller = new AbortController();
    const timeoutReason = new DOMException("deadline exceeded", "TimeoutError");

    const result = throwIfAborted(controller.signal);
    controller.abort(timeoutReason);

    await expect(result).rejects.toBe(timeoutReason);
  });
});
