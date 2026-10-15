import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { cacheKeys } from "./keys.js";
import { TAKEOFF_CACHE_NAME, workersCache } from "./workers-api.js";
import { buildCacheBaseUrl } from "../../config.js";
import { mergeCooldownSchema } from "../../repository/cache/interface.js";
import { logger } from "../../util/logger.js";

// installation-id は getInstallationToken の URL に流れるため z.number().int().positive() で防御する
const installationIdSchema = z.number().int().positive();

describe("workersCache.get schema 検証", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schema に適合する installation-id は round-trip で返す", async () => {
    const key = cacheKeys.installationId("https://wc-install-id-ok.example.com", "app", "org");
    await workersCache.set(key, 42, 60);

    await expect(workersCache.get(key, installationIdSchema)).resolves.toBe(42);
  });

  it("Cache API の read 障害を miss として扱い cooldown 利用側を fail-open にする", async () => {
    const key = cacheKeys.mergeCooldown("https://wc-read-failure.example.com", "repo-1", 42);
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    vi.spyOn(caches, "open").mockRejectedValueOnce(new Error("cache unavailable"));

    await expect(workersCache.get(key, mergeCooldownSchema)).resolves.toBeNull();
    expect(logSpy).toHaveBeenCalledWith("error", {
      event: "workers_cache_get_failed",
      error: "Error: cache unavailable",
    });
  });

  it("既定 cache とは別の named cache へ書き、公開 origin の URL では読めない", async () => {
    const cacheBaseUrl = buildCacheBaseUrl("https://takeoff-isolation.example.com");
    const key = cacheKeys.prList(cacheBaseUrl, "repo-1");
    const valueSchema = z.object({ value: z.literal("private") });

    await workersCache.set(key, { value: "private" }, 60);

    await expect(workersCache.get(key, valueSchema)).resolves.toEqual({ value: "private" });
    // 同じ key でも既定 cache には存在しない
    await expect(caches.default.match(new Request(key))).resolves.toBeUndefined();
    // 公開 origin 側の URL には entry を作らない
    await expect(
      caches.default.match(new Request("https://takeoff-isolation.example.com/_cache/pr-list/repo-1"))
    ).resolves.toBeUndefined();
    const namedCache = await caches.open(TAKEOFF_CACHE_NAME);
    await expect(
      namedCache.match(new Request("https://takeoff-isolation.example.com/_cache/pr-list/repo-1"))
    ).resolves.toBeUndefined();
  });

  it.each([
    { name: "負数", value: -1 },
    { name: "文字列", value: "abc" },
    { name: "小数", value: 1.5 },
  ])("installation-id に $name が混入したら null を返し workers_cache_value_invalid をログする", async ({ value }) => {
    const key = cacheKeys.installationId("https://wc-install-id-bad.example.com", "app", String(value));
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    // set は value: unknown を受けるため、schema に合わない値も production の書き込み経路のまま seed できる
    await workersCache.set(key, value, 60);

    await expect(workersCache.get(key, installationIdSchema)).resolves.toBeNull();
    const invalidCalls = logSpy.mock.calls.filter((call) => call[1].event === "workers_cache_value_invalid");
    expect(invalidCalls).toHaveLength(1);
    const detail = invalidCalls[0]?.[1];
    expect(detail?.key).toBe(key);
    expect(detail?.issueCount).toBeGreaterThan(0);
  });
});
