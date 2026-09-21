import { describe, expect, it } from "vitest";

import { CacheDeliveryRepository, createDeliveryCacheKey, DELIVERY_CACHE_NAME } from "./impl.js";

import type { CacheLike, CacheStorageLike } from "./impl.js";

class MemoryCache implements CacheLike {
  readonly entries = new Map<string, Response>();
  hangRead = false;
  hangWrite = false;

  match(request: Request): Promise<Response | undefined> {
    if (this.hangRead) return new Promise(() => undefined);
    return Promise.resolve(this.entries.get(request.url)?.clone());
  }

  put(request: Request, response: Response): Promise<void> {
    if (this.hangWrite) return new Promise(() => undefined);
    this.entries.set(request.url, response.clone());
    return Promise.resolve();
  }
}

class MemoryCacheStorage implements CacheStorageLike {
  readonly cache = new MemoryCache();
  readonly openedNames: string[] = [];

  open(cacheName: string): Promise<CacheLike> {
    this.openedNames.push(cacheName);
    return Promise.resolve(this.cache);
  }
}

describe("CacheDeliveryRepository", () => {
  it("専用の cache 名と設定した TTL で delivery を処理済みとして記録する", async () => {
    const storage = new MemoryCacheStorage();
    const cache = new CacheDeliveryRepository(1234, storage);
    const signal = new AbortController().signal;

    expect(await cache.has("delivery/1", "auto-assign", signal)).toBe(false);
    await cache.markProcessed("delivery/1", "auto-assign", new Date("2026-07-16T00:00:00.000Z"), signal);

    expect(await cache.has("delivery/1", "auto-assign", signal)).toBe(true);
    expect(storage.openedNames).toEqual([DELIVERY_CACHE_NAME, DELIVERY_CACHE_NAME, DELIVERY_CACHE_NAME]);
    const storedResponse = [...storage.cache.entries.values()][0];
    expect(storedResponse?.headers.get("Cache-Control")).toBe("public, max-age=1234");
    await expect(storedResponse?.json()).resolves.toEqual({ processedAt: "2026-07-16T00:00:00.000Z" });
  });

  it("機能ごとに cache key を分け、delivery ID を encode する", () => {
    expect(createDeliveryCacheKey({ deliveryId: "owner/repo delivery", feature: "auto-assign" }).url).toBe(
      "https://cache.internal/github/deliveries/owner%2Frepo%20delivery/auto-assign"
    );
    expect(createDeliveryCacheKey({ deliveryId: "owner/repo delivery", feature: "title-validation" }).url).toBe(
      "https://cache.internal/github/deliveries/owner%2Frepo%20delivery/title-validation"
    );
  });

  it("応答しない cache の read と write を timeout で打ち切る", async () => {
    const readStorage = new MemoryCacheStorage();
    readStorage.cache.hangRead = true;
    const readRepository = new CacheDeliveryRepository(60, readStorage, 5);
    await expect(readRepository.has("delivery-read", "auto-assign", new AbortController().signal)).rejects.toThrow(
      "timed out"
    );

    const writeStorage = new MemoryCacheStorage();
    writeStorage.cache.hangWrite = true;
    const writeRepository = new CacheDeliveryRepository(60, writeStorage, 5);
    await expect(
      writeRepository.markProcessed("delivery-write", "title-validation", new Date(), new AbortController().signal)
    ).rejects.toThrow("timed out");
  });

  it("Webhook の deadline に達したあとは cache 操作を開始も継続もしない", async () => {
    const storage = new MemoryCacheStorage();
    const repository = new CacheDeliveryRepository(60, storage, 5_000);
    const controller = new AbortController();
    controller.abort(new Error("deadline reached"));

    await expect(repository.has("delivery-aborted", "auto-assign", controller.signal)).rejects.toThrow(
      "deadline reached"
    );
    expect(storage.openedNames).toEqual([]);

    const hangingStorage = new MemoryCacheStorage();
    hangingStorage.cache.hangRead = true;
    const hangingRepository = new CacheDeliveryRepository(60, hangingStorage, 5_000);
    const activeController = new AbortController();
    const pending = hangingRepository.has("delivery-active", "auto-assign", activeController.signal);
    activeController.abort(new Error("deadline reached"));
    await expect(pending).rejects.toThrow("deadline reached");
  });
});
