import { once } from "../single-flight.js";
import { warmInBackground } from "../timeout-budget.js";

import type { Env } from "../../../env.js";
import type { TimeoutBudget } from "../timeout-budget.js";
import type { Context } from "hono";

export type CachedLoadResult<T> = { status: "ready"; value: T } | { status: "loading" };

export interface CachedLoad<T> {
  /**
   * 記録と単一実行の key に使う
   * cache 読み出しは `${label}_cache` として記録する
   */
  label: string;
  /**
   * 対象ごとに読み込みをまとめる key
   * 既定は label
   */
  key?: string;
  readCache: () => Promise<T | null>;
  load: () => Promise<T>;
}

/**
 * cache 読み出しと本体の読み込みをともに request の制限時間の対象にする
 * Cache API と KV は signal を受け取らずコード側の timeout も持たないため、
 * 制限時間の対象にしない限り Discord の 3 秒を超えても待ち続けてしまう
 * 制限時間を超えた場合は読み込みを応答後の warming へ回し、呼び出し側は読み込み中を案内する
 */
export const loadCached = async <T>(
  c: Context<Env>,
  budget: TimeoutBudget,
  { label, key = label, readCache, load }: CachedLoad<T>
): Promise<CachedLoadResult<T>> => {
  const cached = await budget.race(readCache, `${label}_cache`);
  if (cached.status === "loading") {
    // 制限時間を超えた cache 読み出しは待たない
    // 放置しても budget.race が rejection を引き受けている
    // 読み出しが遅い状態が続くと読み込み中から抜けられないため、本体の読み込みで cache を温める
    warmInBackground(c, label, once(key, load));
    return { status: "loading" };
  }
  if (cached.value !== null) return { status: "ready", value: cached.value };

  const loaded = await budget.race(() => once(key, load), label);
  if (loaded.status === "loading") {
    warmInBackground(c, label, loaded.warming);
    return { status: "loading" };
  }
  return { status: "ready", value: loaded.value };
};
