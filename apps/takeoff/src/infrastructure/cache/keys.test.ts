import { describe, expect, it } from "vitest";

import { cacheKeys } from "./keys.js";
import { buildCacheBaseUrl, CACHE_KEY_ORIGIN } from "../../config.js";

const publicBaseUrl = "https://takeoff-keys.example.com";
const cacheBaseUrl = buildCacheBaseUrl(publicBaseUrl);

const allKeys = (base: string): string[] => [
  cacheKeys.prList(base, "repo-id"),
  cacheKeys.repoIndex(base),
  cacheKeys.mergeCooldown(base, "repo-id", 42),
  cacheKeys.syncCooldown(base, "repo-id"),
  cacheKeys.installationId(base, "app-id", "org"),
  cacheKeys.installationToken(base, 123),
  cacheKeys.installationRepositories(base),
];

describe("cacheKeys", () => {
  it("すべての key を到達不能な内部 origin へ置き、公開 origin を含めない", () => {
    const keys = allKeys(cacheBaseUrl);

    expect(keys).toHaveLength(7);
    for (const key of keys) {
      const url = new URL(key);
      expect(url.origin).toBe(CACHE_KEY_ORIGIN);
      // 公開 origin は encode された環境識別子としてだけ現れ、そのままの形では現れない
      expect(key).not.toContain(publicBaseUrl);
      expect(key.startsWith(`${CACHE_KEY_ORIGIN}/${encodeURIComponent(publicBaseUrl)}/`)).toBe(true);
    }
  });

  it("同じ環境の key は互いに衝突しない", () => {
    const keys = allKeys(cacheBaseUrl);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("環境が違えば同じ種類の key も分離される", () => {
    const staging = buildCacheBaseUrl("https://takeoff-keys-staging.example.com");

    const productionKeys = new Set(allKeys(cacheBaseUrl));
    expect(allKeys(staging).every((key) => !productionKeys.has(key))).toBe(true);
  });
});
