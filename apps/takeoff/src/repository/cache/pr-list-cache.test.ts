import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestListCacheImpl } from "./impl.js";
import { cacheKeys } from "../../infrastructure/cache/keys.js";
import { memoryCache } from "../../infrastructure/cache/memory-cache.js";
import { workersCache } from "../../infrastructure/cache/workers-api.js";
import { logger } from "../../util/logger.js";

const spyOnConsoleError = () =>
  vi.spyOn(logger, "log").mockImplementation(() => {
    // この test では log の出力を意図的に抑止する
  });

// null は cache miss でも起きるため、schema 検証で捨てたことは log で直接確認する
const expectValueInvalidLogged = (spy: { mock: { calls: unknown[][] } }, key: string): void => {
  const invalidCalls = spy.mock.calls.filter(
    (call) => (call[1] as { event?: string } | undefined)?.event === "workers_cache_value_invalid"
  );
  expect(invalidCalls).toHaveLength(1);
  expect((invalidCalls[0]?.[1] as { key: string }).key).toBe(key);
};

describe("PullRequestListCacheImpl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PR 一覧を Cache API 経由で保存、取得、削除する", async () => {
    const baseUrl = "https://pr-list-cache.example.com";
    const cache = new PullRequestListCacheImpl(baseUrl, 60);
    const key = cacheKeys.prList(baseUrl, "1");
    const data = {
      repoId: "1",
      items: [],
      fetchedAt: new Date().toISOString(),
    };

    await cache.set("1", data);
    // memory hit で返すと Cache API の書き込みが壊れていても test が成功するため、memory を落としてから読む
    memoryCache.delete(key);
    await expect(cache.get("1")).resolves.toEqual(data);

    await cache.delete("1");
    memoryCache.delete(key);
    await expect(cache.get("1")).resolves.toBeNull();
  });

  it("設定 TTL を過ぎた Cache API entry は memory に載せずに返す", async () => {
    const baseUrl = "https://pr-list-expired.example.com";
    const cache = new PullRequestListCacheImpl(baseUrl, 60);
    const key = cacheKeys.prList(baseUrl, "9");
    // 旧 TTL 設定（長い s-maxage）で別 isolate が書いた entry を再現する
    // fetchedAt は現在の設定 TTL（60 秒）を大きく過ぎている
    const stale = {
      repoId: "9",
      items: [],
      fetchedAt: new Date(Date.now() - 120_000).toISOString(),
    };
    await workersCache.set(key, stale, 300);

    await expect(cache.get("9")).resolves.toEqual(stale);

    expect(memoryCache.get(key)).toBeNull();
  });

  it("残り有効期限内の Cache API entry は残り時間だけ memory に載せて返す", async () => {
    const baseUrl = "https://pr-list-rehydrate.example.com";
    const cache = new PullRequestListCacheImpl(baseUrl, 60);
    const fresh = {
      repoId: "10",
      items: [],
      fetchedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    await workersCache.set(cacheKeys.prList(baseUrl, "10"), fresh, 300);

    await expect(cache.get("10")).resolves.toEqual(fresh);
  });

  it("items が欠落した不正な shape は miss として null を返す", async () => {
    const baseUrl = "https://pr-list-missing-items.example.com";
    const cache = new PullRequestListCacheImpl(baseUrl, 60);
    const key = cacheKeys.prList(baseUrl, "11");
    const logSpy = spyOnConsoleError();
    // 別 isolate や過去バージョンが書いた不正な値を模す
    await workersCache.set(key, { repoId: "11", fetchedAt: new Date().toISOString() }, 60);

    await expect(cache.get("11")).resolves.toBeNull();

    expectValueInvalidLogged(logSpy, key);
  });

  it("fetchedAt が string でない不正な shape は miss として null を返す", async () => {
    const baseUrl = "https://pr-list-invalid-fetchedat.example.com";
    const cache = new PullRequestListCacheImpl(baseUrl, 60);
    const key = cacheKeys.prList(baseUrl, "12");
    const logSpy = spyOnConsoleError();
    await workersCache.set(key, { repoId: "12", items: [], fetchedAt: 123 }, 60);

    await expect(cache.get("12")).resolves.toBeNull();

    expectValueInvalidLogged(logSpy, key);
  });
});
