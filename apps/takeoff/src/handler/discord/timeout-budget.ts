/**
 * Discord の interaction は request 内で 3 秒以内に応答しないと「This interaction failed」になり、Worker 側は成功扱いのまま記録も残らない
 * deferred を返せない autocomplete では、request 全体で 1 つの deadline を共有し、超えたら degrade した候補を返す
 */
import { errors } from "../../domain/errors.js";
import { errorDetail } from "../../util/error-detail.js";

import type { Env } from "../../env.js";
import type { Context } from "hono";

// Discord の 3 秒に対し、署名検証と応答送信の余裕を残した autocomplete 全体の読み込みに割り当てた制限時間
export const AUTOCOMPLETE_TIMEOUT_MS = 1500;

// 読み込み中を表す候補の value
// 利用者が選んで実行しても、command 側で読み込み中として扱う
export const LOADING_VALUE = "__loading__";

// 読み込み中の候補名
export const REPOSITORY_LIST_LOADING_MESSAGE = "リポジトリ一覧を読み込み中です。もう一度入力してください。";
export const PULL_REQUESTS_LOADING_MESSAGE = "PR 一覧を読み込み中です。もう一度入力してください。";

/**
 * autocomplete の候補 value が読み込み中の sentinel なら、読み込み中の案内へ振り分ける
 * 判定を command ごとに複製すると経路の追加時に漏れるため、この関数を唯一の判定箇所とする
 */
export const assertNotLoadingSentinel = (value: string | undefined): void => {
  if (value === LOADING_VALUE) throw errors.invalidRequest("候補を読み込み中です。もう一度入力してください。");
};

export interface TimeoutBudget {
  /**
   * deadline までの残り時間
   * 超過後は 0
   */
  remainingMs(): number;
  /**
   * `start` を残り時間で実行する
   * 制限時間内に終われば値を返し、超えたら実行中の読み込みを warming として返す
   * cache API や KV のように signal を受け取れない読み込みも打ち切れるよう、abort ではなく race で行う
   */
  race<T>(start: () => Promise<T>, label: string): Promise<TimeoutLoadResult<T>>;
}

/**
 * request 内で共有する deadline を作る
 * 多段の読み込みが制限時間を分け合っても合計が総量を超えない
 */
export const createTimeoutBudget = (totalMs: number = AUTOCOMPLETE_TIMEOUT_MS): TimeoutBudget => {
  const deadline = Date.now() + totalMs;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());
  return {
    remainingMs,
    race: (start, label) => loadWithTimeout(start, remainingMs(), label),
  };
};

/**
 * 制限時間を超えた読み込みを応答後の実行へ回す
 * 失敗しても次の request で取得し直すため無視する
 */
export const warmInBackground = (c: Context<Env>, label: string, warming: Promise<unknown>): void => {
  c.executionCtx.waitUntil(
    warming.catch((error: unknown) => {
      // warming の失敗は利用者の操作に影響しないが、恒常的な失敗を検知できるよう記録する
      console.warn("discord_autocomplete_warming_failed", { label, error: errorDetail(error) });
    })
  );
};

export type TimeoutLoadResult<T> = { status: "ready"; value: T } | { status: "loading"; warming: Promise<T> };

const budgetExceeded = <T>(label: string, warming: Promise<T>): TimeoutLoadResult<T> => {
  console.warn("discord_autocomplete_budget_exceeded", { label });
  return { status: "loading", warming };
};

type SettledResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/*
 * `loader` を `timeoutMs` を制限時間として実行する
 * 制限時間内に終われば値を返し、超えたら実行中の読み込みを `warming` として呼び出し側の `waitUntil` へ回す
 * 打ち切りは abort ではなく race で行う
 * abort すると読み直しで GitHub API を二重に叩くうえ、`getRepositoryIndex` のように signal を受け取らない読み込みには効かないため
 */
export const loadWithTimeout = async <T>(
  loader: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<TimeoutLoadResult<T>> => {
  const started = loader();
  // race より先に rejection を受け取り、timeout 後に loader が失敗しても unhandled rejection にしない
  const settled: Promise<SettledResult<T>> = started.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  );

  // 前段が制限時間を使い切った場合、後段は待たずに degrade する
  if (timeoutMs <= 0) return budgetExceeded(label, started);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const winner = await Promise.race([settled, timeout]);
    if (winner !== "timeout") {
      if (winner.ok) return { status: "ready", value: winner.value };
      throw winner.error;
    }

    return budgetExceeded(label, started);
  } finally {
    clearTimeout(timer);
  }
};
