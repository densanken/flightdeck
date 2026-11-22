import { describe, expect, it } from "vitest";

import { createSkipCache } from "./skip-cache.js";

const fakeCache = () => {
  const entries = new Map<string, Response>();

  return {
    entries,
    match: (key: string) => Promise.resolve(entries.get(key)),
    put: (key: string, response: Response) => {
      entries.set(key, response);
      return Promise.resolve();
    },
  };
};

describe("createSkipCache", () => {
  it("覚えた branch だけを、期限内と答える", async () => {
    const cache = createSkipCache(fakeCache());

    await cache.remember(1, "renovate/a", 10_000, 0);

    expect(await cache.has(1, ["renovate/a"])).toBe(true);
    expect(await cache.has(1, ["renovate/b"])).toBe(false);
    expect(await cache.has(2, ["renovate/a"])).toBe(false);
  });

  it("branches の一部でも覚えていなければ、期限内と答えない", async () => {
    const cache = createSkipCache(fakeCache());

    await cache.remember(1, "renovate/a", 10_000, 0);

    expect(await cache.has(1, ["renovate/a", "renovate/b"])).toBe(false);
    expect(await cache.has(1, [])).toBe(false);
  });

  it("期限までの秒数を max-age にし、期限が過ぎていれば覚えない", async () => {
    const store = fakeCache();
    const cache = createSkipCache(store);

    await cache.remember(1, "renovate/a", 90_500, 0);
    await cache.remember(1, "renovate/b", 1_000, 2_000);

    expect([...store.entries.keys()]).toEqual(["https://skip-cache.flightdeck.internal/1/renovate%2Fa"]);
    expect(
      store.entries.get("https://skip-cache.flightdeck.internal/1/renovate%2Fa")?.headers.get("Cache-Control")
    ).toBe("max-age=90");
  });

  it("Cache API が失敗しても、評価に進める", async () => {
    const failing = createSkipCache({
      match: () => Promise.reject(new Error("failed")),
      put: () => Promise.reject(new Error("failed")),
    });

    expect(await failing.has(1, ["renovate/a"])).toBe(false);
    await expect(failing.remember(1, "renovate/a", 10_000, 0)).resolves.toBeUndefined();
  });
});
