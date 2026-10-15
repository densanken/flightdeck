import { errorDetail } from "../../util/error-detail.js";
import { logger } from "../../util/logger.js";

import type { z } from "zod";

// 既定 cache（`caches.default`）は edge の HTTP cache と同じ空間のため、
// takeoff 専用の named cache へ隔離する
// key の内部 origin と合わせて二重に分離する
export const TAKEOFF_CACHE_NAME = "takeoff:app";

// open は同じ named cache への参照を返すだけなので、操作ごとに開いて失敗を局所化する
const openCache = (): Promise<Cache> => caches.open(TAKEOFF_CACHE_NAME);

// Cache API は colo-local かつ non-atomic な best-effort の最適化として扱う
// read 失敗は miss、write/delete 失敗はログのみとし、Cache API の局所障害が本体の障害に波及しないようにする
// cooldown は別 colo や同時 miss の重複を防がず、Cache API の read 障害も miss として扱う
export const workersCache = {
  // Cache API の値は別 isolate や過去バージョンが書いた可能性があるため unknown として扱い、呼び出し元の schema で検証する
  // parse に失敗した値は cache miss として捨てる
  async get<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      const cache = await openCache();
      const response = await cache.match(new Request(key));
      if (!response) return null;
      const raw: unknown = await response.json();
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        logger.log("error", { event: "workers_cache_value_invalid", key, issueCount: parsed.error.issues.length });
        return null;
      }
      return parsed.data;
    } catch (error) {
      logger.log("error", { event: "workers_cache_get_failed", error: errorDetail(error) });
      return null;
    }
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const cache = await openCache();
      const response = new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `s-maxage=${String(ttlSeconds)}`,
        },
      });
      await cache.put(new Request(key), response);
    } catch (error) {
      logger.log("error", { event: "workers_cache_set_failed", error: errorDetail(error) });
    }
  },

  async delete(key: string): Promise<void> {
    try {
      const cache = await openCache();
      await cache.delete(new Request(key));
    } catch (error) {
      logger.log("error", { event: "workers_cache_delete_failed", error: errorDetail(error) });
    }
  },
};
