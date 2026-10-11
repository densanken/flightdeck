import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryCache } from "./memory-cache.js";

describe("memoryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("期限切れ entry は get 時に削除して null を返す", () => {
    memoryCache.set("expired-key", "value", 1);

    vi.advanceTimersByTime(1_001);

    expect(memoryCache.get("expired-key")).toBeNull();
  });

  it("TTL の期限と同時刻になった entry を期限切れとして扱う", () => {
    memoryCache.set("expires-now", "value", 1);

    vi.advanceTimersByTime(1_000);

    expect(memoryCache.get("expires-now")).toBeNull();
  });

  it.each([0, -1])("非正の TTL %s は保存せず、同じ key の古い値も残さない", (ttlSeconds) => {
    memoryCache.set("active", "old", 60);

    memoryCache.set("active", "new", ttlSeconds);

    expect(memoryCache.get("active")).toBeNull();
  });

  it("delete は期限に関係なく指定 key を削除する", () => {
    memoryCache.set("key", "value", 60);
    memoryCache.delete("key");
    expect(memoryCache.get("key")).toBeNull();
  });
});
