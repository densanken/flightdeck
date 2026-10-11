import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CacheInstallationRepositoryStore,
  CacheMergeCooldownStore,
  CacheRepoIndexCacheStore,
  CacheSyncCooldownStore,
} from "./impl.js";
import { cacheKeys } from "../../infrastructure/cache/keys.js";
import { memoryCache } from "../../infrastructure/cache/memory-cache.js";
import { workersCache } from "../../infrastructure/cache/workers-api.js";

// store.get() は memory cache を先に引くため、set() 直後に get() すると Cache API を通らず同一オブジェクト参照が返る
// Cache API 経由の hit を検査するテストは memory を落としてから読む
const dropMemory = (key: string): void => {
  memoryCache.delete(key);
};

const spyOnConsoleError = () =>
  vi.spyOn(console, "error").mockImplementation(() => {
    // この test では console.error の出力を意図的に抑止する
  });

// workersCache.get が schema 検証で値を捨てたことを、null という結果ではなく log で直接確認する
// null は cache miss でも起きるため、結果だけでは検証経路を素通りしても test が成功する
const expectValueInvalidLogged = (spy: { mock: { calls: unknown[][] } }, key: string): void => {
  const invalidCalls = spy.mock.calls.filter((call) => call[0] === "workers_cache_value_invalid");
  expect(invalidCalls).toHaveLength(1);
  expect((invalidCalls[0]?.[1] as { key: string }).key).toBe(key);
};

describe("cache store implementations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merge cooldown を Cache API 経由で保存して取得する", async () => {
    const baseUrl = "https://merge-cache.example.com";
    const store = new CacheMergeCooldownStore(baseUrl, 60);
    const data = {
      repoId: "1",
      prNumber: 42,
      requestedAt: "2024-01-01T00:00:00Z",
      requestedByDiscordUserId: "user",
    };

    await store.set("1", 42, data);
    dropMemory(cacheKeys.mergeCooldown(baseUrl, "1", 42));

    await expect(store.get("1", 42)).resolves.toEqual(data);
  });

  it("sync cooldown を Cache API 経由で保存して取得する", async () => {
    const baseUrl = "https://sync-cache.example.com";
    const store = new CacheSyncCooldownStore(baseUrl, 60);
    const data = {
      repoId: "1",
      requestedAt: "2024-01-01T00:00:00Z",
      requestedByDiscordUserId: "user",
    };

    await store.set("1", data);
    dropMemory(cacheKeys.syncCooldown(baseUrl, "1"));

    await expect(store.get("1")).resolves.toEqual(data);
  });

  it("sync cooldown を明示的に削除する", async () => {
    const baseUrl = "https://sync-cache-delete.example.com";
    const store = new CacheSyncCooldownStore(baseUrl, 60);
    const data = {
      repoId: "1",
      requestedAt: "2024-01-01T00:00:00Z",
      requestedByDiscordUserId: "user",
    };

    await store.set("1", data);
    await store.delete("1");
    dropMemory(cacheKeys.syncCooldown(baseUrl, "1"));

    await expect(store.get("1")).resolves.toBeNull();
  });

  it("repo-index を明示的に無効化して再構築値へ置換する", async () => {
    const baseUrl = "https://repo-index-cache.example.com";
    const store = new CacheRepoIndexCacheStore(baseUrl, 60);
    const key = cacheKeys.repoIndex(baseUrl);
    const stale = { items: [], updatedAt: "2024-01-01T00:00:00Z" };
    const rebuilt = {
      items: [
        {
          repoId: "1",
          owner: "org",
          name: "repo",
          fullName: "org/repo",
          htmlUrl: "https://github.com/org/repo",
        },
      ],
      updatedAt: "2024-01-02T00:00:00Z",
    };

    await store.set(stale);
    dropMemory(key);
    await expect(store.get()).resolves.toEqual(stale);

    await store.invalidate();
    dropMemory(key);
    await expect(store.get()).resolves.toBeNull();

    await store.set(rebuilt);
    dropMemory(key);
    await expect(store.get()).resolves.toEqual(rebuilt);
  });

  it("repo-index の memory cache TTL を最大 300 秒に制限する", async () => {
    const store = new CacheRepoIndexCacheStore("https://repo-index-memory-ttl.example.com", 86400);
    const data = { items: [], updatedAt: "2024-01-01T00:00:00Z" };
    const setSpy = vi.spyOn(memoryCache, "set");

    await store.set(data);

    expect(setSpy).toHaveBeenCalledWith("https://repo-index-memory-ttl.example.com/_cache/repo-index", data, 300);
  });

  it("TTL 終了直前に Cache API から取得した repo-index を期限後まで有効にしない", async () => {
    const store = new CacheRepoIndexCacheStore("https://repo-index-no-rehydrate.example.com", 60);
    const data = { items: [], updatedAt: "2026-08-11T00:00:00.000Z" };
    const getSpy = vi.spyOn(workersCache, "get").mockResolvedValueOnce(data).mockResolvedValueOnce(null);
    vi.useFakeTimers();
    vi.setSystemTime(59_000);

    try {
      await expect(store.get()).resolves.toEqual(data);
      vi.advanceTimersByTime(1_001);
      await expect(store.get()).resolves.toBeNull();

      expect(getSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installation repository 一覧を Cache API 経由で保存して取得する", async () => {
    const baseUrl = "https://installation-cache.example.com";
    const store = new CacheInstallationRepositoryStore(baseUrl, 60);
    const data = {
      items: [
        {
          id: 1,
          owner: "org",
          name: "repo",
          fullName: "org/repo",
          htmlUrl: "https://github.com/org/repo",
        },
      ],
      fetchedAt: new Date().toISOString(),
    };

    await store.set(data);
    dropMemory(cacheKeys.installationRepositories(baseUrl));

    await expect(store.get()).resolves.toEqual(data);
  });

  it("設定 TTL を過ぎた installation repository 一覧の entry は memory に載せずに返す", async () => {
    const baseUrl = "https://installation-repos-expired.example.com";
    const store = new CacheInstallationRepositoryStore(baseUrl, 60);
    const key = cacheKeys.installationRepositories(baseUrl);
    // 旧 TTL 設定（長い s-maxage）で別 isolate が書いた entry を再現する
    // fetchedAt は現在の設定 TTL（60 秒）を大きく過ぎている
    const stale = { items: [], fetchedAt: new Date(Date.now() - 120_000).toISOString() };
    await workersCache.set(key, stale, 300);

    await expect(store.get()).resolves.toEqual(stale);

    expect(memoryCache.get(key)).toBeNull();
  });

  it("残り有効期限内の installation repository 一覧は残り時間だけ memory に載せて返す", async () => {
    const baseUrl = "https://installation-repos-rehydrate.example.com";
    const store = new CacheInstallationRepositoryStore(baseUrl, 60);
    const key = cacheKeys.installationRepositories(baseUrl);
    const fresh = { items: [], fetchedAt: new Date(Date.now() - 10_000).toISOString() };
    await workersCache.set(key, fresh, 300);
    const memorySetSpy = vi.spyOn(memoryCache, "set");

    await expect(store.get()).resolves.toEqual(fresh);

    // 固定 TTL ではなく残り時間（設定 60 秒 - 経過 10 秒）を memory に載せる
    const rehydrateCall = memorySetSpy.mock.calls.find((call) => call[0] === key);
    expect(rehydrateCall?.[1]).toEqual(fresh);
    expect(rehydrateCall?.[2]).toBeGreaterThan(45);
    expect(rehydrateCall?.[2]).toBeLessThanOrEqual(50);
  });

  it("Cache API に不正な shape の repo-index が入っていたら miss として null を返す", async () => {
    const baseUrl = "https://repo-index-invalid-shape.example.com";
    const store = new CacheRepoIndexCacheStore(baseUrl, 60);
    const key = cacheKeys.repoIndex(baseUrl);
    const consoleErrorSpy = spyOnConsoleError();
    // 別 isolate や過去バージョンが書いた不正な値を模す
    await workersCache.set(key, { items: "not-an-array" }, 60);

    await expect(store.get()).resolves.toBeNull();

    expectValueInvalidLogged(consoleErrorSpy, key);
  });

  it("Cache API に不正な shape の merge cooldown が入っていたら miss として null を返す", async () => {
    const baseUrl = "https://merge-cooldown-invalid-shape.example.com";
    const store = new CacheMergeCooldownStore(baseUrl, 60);
    const key = cacheKeys.mergeCooldown(baseUrl, "1", 42);
    const consoleErrorSpy = spyOnConsoleError();
    await workersCache.set(key, { repoId: 1, prNumber: "not-a-number" }, 60);

    await expect(store.get("1", 42)).resolves.toBeNull();

    expectValueInvalidLogged(consoleErrorSpy, key);
  });

  it("Cache API に不正な shape の sync cooldown が入っていたら miss として null を返す", async () => {
    const baseUrl = "https://sync-cooldown-invalid-shape.example.com";
    const store = new CacheSyncCooldownStore(baseUrl, 60);
    const key = cacheKeys.syncCooldown(baseUrl, "1");
    const consoleErrorSpy = spyOnConsoleError();
    await workersCache.set(key, { repoId: 1, requestedAt: 123 }, 60);

    await expect(store.get("1")).resolves.toBeNull();

    expectValueInvalidLogged(consoleErrorSpy, key);
  });

  it("Cache API に不正な shape の installation repository 一覧が入っていたら miss として null を返す", async () => {
    const baseUrl = "https://installation-repos-invalid-shape.example.com";
    const store = new CacheInstallationRepositoryStore(baseUrl, 60);
    const key = cacheKeys.installationRepositories(baseUrl);
    const consoleErrorSpy = spyOnConsoleError();
    await workersCache.set(key, { items: "not-an-array", fetchedAt: new Date().toISOString() }, 60);

    await expect(store.get()).resolves.toBeNull();

    expectValueInvalidLogged(consoleErrorSpy, key);
  });
});
