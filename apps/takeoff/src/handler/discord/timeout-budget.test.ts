import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertNotLoadingSentinel,
  createTimeoutBudget,
  LOADING_VALUE,
  loadWithTimeout,
  warmInBackground,
} from "./timeout-budget.js";
import { AppError } from "../../domain/errors.js";
import { logger } from "../../util/logger.js";

import type { Env } from "../../env.js";
import type { Context } from "hono";

const silenceConsole = (): void => {
  vi.spyOn(logger, "log").mockImplementation(() => {
    // 超過の記録はここでは検証しない
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadWithTimeout", () => {
  it("timeout 前に完了した値を返す", async () => {
    await expect(loadWithTimeout(() => Promise.resolve("ready"), 100, "test")).resolves.toEqual({
      status: "ready",
      value: "ready",
    });
  });

  it("timeout 時は実行中の読み込みを warming として返し、二重に呼ばない", async () => {
    silenceConsole();
    let calls = 0;
    const loader = (): Promise<string> => {
      calls += 1;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve("late");
        }, 30);
      });
    };

    const result = await loadWithTimeout(loader, 1, "test");

    expect(result.status).toBe("loading");
    if (result.status === "loading") {
      await expect(result.warming).resolves.toBe("late");
    }
    expect(calls).toBe(1);
  });

  it("制限時間が残っていないときは待たずに degrade し、読み込みは warming として継続する", async () => {
    silenceConsole();
    let resolved = false;
    const loader = (): Promise<string> =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve("late");
        }, 10);
      });

    const result = await loadWithTimeout(loader, 0, "test");

    expect(result.status).toBe("loading");
    expect(resolved).toBe(false);
    if (result.status === "loading") {
      await expect(result.warming).resolves.toBe("late");
    }
  });

  it("制限時間を超えたことを label 付きで記録する", async () => {
    const warn = vi.spyOn(logger, "log").mockImplementation(() => {
      // 記録内容だけを検証する
    });

    await loadWithTimeout(() => new Promise<string>(() => undefined), 0, "repository_index");

    expect(warn).toHaveBeenCalledWith("warn", {
      event: "discord_autocomplete_budget_exceeded",
      label: "repository_index",
    });
  });

  it("timeout 前の失敗はそのまま呼び出し側へ投げる", async () => {
    await expect(loadWithTimeout(() => Promise.reject(new Error("boom")), 100, "test")).rejects.toThrow("boom");
  });
});

describe("createTimeoutBudget", () => {
  it("多段の読み込みで残り時間を共有する", async () => {
    const budget = createTimeoutBudget(50);
    const first = budget.remainingMs();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(50);
    // deadline を過ぎたら残りは 0 になり、後段は待たずに degrade する
    expect(budget.remainingMs()).toBe(0);
  });
});

describe("createTimeoutBudget().race", () => {
  it("cache 読み出しのような signal を受け取れない読み込みも残り時間で打ち切る", async () => {
    silenceConsole();
    const budget = createTimeoutBudget(20);

    const result = await budget.race(() => new Promise<string>(() => undefined), "repository_index_cache");

    expect(result.status).toBe("loading");
  });

  it("前段が使った時間を後段の制限時間から差し引く", async () => {
    silenceConsole();
    const budget = createTimeoutBudget(40);

    await budget.race(() => new Promise<string>(() => undefined), "first");
    const startedAt = Date.now();
    const second = await budget.race(() => new Promise<string>(() => undefined), "second");

    // 前段で制限時間を使い切っているため、後段は待たずに degrade する
    expect(second.status).toBe("loading");
    expect(Date.now() - startedAt).toBeLessThan(20);
  });
});

describe("warmInBackground", () => {
  const createContext = (promises: Promise<unknown>[]): Context<Env> =>
    ({
      executionCtx: {
        waitUntil: (promise: Promise<unknown>) => {
          promises.push(promise);
        },
      },
    }) as unknown as Context<Env>;

  it("warming の失敗を label 付きで記録する", async () => {
    const warn = vi.spyOn(logger, "log").mockImplementation(() => {
      // 記録内容だけを検証する
    });
    const promises: Promise<unknown>[] = [];

    warmInBackground(createContext(promises), "repository_index", Promise.reject(new Error("boom")));
    await Promise.all(promises);

    expect(warn).toHaveBeenCalledWith("warn", {
      event: "discord_autocomplete_warming_failed",
      label: "repository_index",
      error: "Error: boom",
    });
  });
});

describe("assertNotLoadingSentinel", () => {
  it("読み込み中候補を案内へ振り分ける", () => {
    expect(() => {
      assertNotLoadingSentinel(LOADING_VALUE);
    }).toThrow(new AppError("invalid_request", "候補を読み込み中です。もう一度入力してください。"));
  });

  it.each([undefined, "", "repo-1", "org/repo", "12"])("通常の値 %j は通す", (value) => {
    expect(() => {
      assertNotLoadingSentinel(value);
    }).not.toThrow();
  });
});
