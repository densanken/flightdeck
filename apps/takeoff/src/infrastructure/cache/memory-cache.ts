interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

export const memoryCache = {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- 呼び出し側が保存時の型を指定して取り出すため
  get<T>(key: string): T | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value as T;
  },

  set(key: string, value: unknown, ttlSeconds: number): void {
    // 期限到達済みの値は保存せず、更新対象の古い値も残さない
    if (ttlSeconds <= 0) {
      store.delete(key);
      return;
    }
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },

  delete(key: string): void {
    store.delete(key);
  },
};
