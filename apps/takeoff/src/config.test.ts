import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildAppConfig, buildCacheBaseUrl, CACHE_KEY_ORIGIN } from "./config.js";
import { cacheKeys } from "./infrastructure/cache/keys.js";
import { workersCache } from "./infrastructure/cache/workers-api.js";

import type { AppConfig } from "./config.js";
import type { Env } from "./env.js";

const bindings = (publicBaseUrl: string): Env["Bindings"] => ({
  ...env,
  GITHUB_APP_PRIVATE_KEY: "private-key",
  DISCORD_PUBLIC_KEY: "public-key",
  DISCORD_APPLICATION_ID: "application-id",
  DISCORD_BOT_TOKEN: "bot-token",
  MERGE_AUDIT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token",
  GITHUB_APP_ID: "github-app-id",
  GITHUB_ORG: "org",
  ALLOWED_GUILD_IDS: "guild-id",
  ADMIN_ROLE_IDS: "role-id",
  PUBLIC_BASE_URL: publicBaseUrl,
});

const allCacheKeys = (config: AppConfig): string[] => [
  cacheKeys.prList(config.cacheBaseUrl, "repo-id"),
  cacheKeys.repoIndex(config.cacheBaseUrl),
  cacheKeys.mergeCooldown(config.cacheBaseUrl, "repo-id", 42),
  cacheKeys.syncCooldown(config.cacheBaseUrl, "repo-id"),
  cacheKeys.installationId(config.cacheBaseUrl, config.githubAppId, config.githubOrg),
  cacheKeys.installationToken(config.cacheBaseUrl, 123),
  cacheKeys.installationRepositories(config.cacheBaseUrl),
];

describe("buildAppConfig cache namespace", () => {
  it("Cache API key を公開 origin から切り離しつつ環境ごとに分離する", () => {
    const production = buildAppConfig(bindings("https://takeoff.example.com/"));
    const staging = buildAppConfig(bindings("https://takeoff-staging.example.com/"));

    // 公開 origin は cache key の origin にしない
    expect(production.cacheBaseUrl).not.toBe("https://takeoff.example.com");
    expect(new URL(production.cacheBaseUrl).origin).toBe(CACHE_KEY_ORIGIN);
    expect(production.cacheBaseUrl).toBe(buildCacheBaseUrl("https://takeoff.example.com"));
    expect(staging.cacheBaseUrl).not.toBe(production.cacheBaseUrl);

    const productionKeys = allCacheKeys(production);
    const stagingKeys = new Set(allCacheKeys(staging));
    expect(productionKeys).toHaveLength(7);
    expect(new Set(productionKeys).size).toBe(productionKeys.length);
    expect(productionKeys.every((key) => !stagingKeys.has(key))).toBe(true);
    // 公開 origin 配下の実在しうる URL にはならない
    expect(productionKeys.every((key) => !key.startsWith("https://takeoff.example.com"))).toBe(true);
    expect(productionKeys.every((key) => new URL(key).origin === CACHE_KEY_ORIGIN)).toBe(true);
  });

  it("host の大文字小文字と既定 port の有無を同じ namespace へ正規化する", () => {
    const lower = buildAppConfig(bindings("https://takeoff-normalize.example.com"));
    const upper = buildAppConfig(bindings("https://TAKEOFF-Normalize.EXAMPLE.com"));
    const defaultPort = buildAppConfig(bindings("https://takeoff-normalize.example.com:443"));

    expect(upper.cacheBaseUrl).toBe(lower.cacheBaseUrl);
    expect(defaultPort.cacheBaseUrl).toBe(lower.cacheBaseUrl);
  });

  it("port と scheme が違う環境は別 namespace になり、key の path segment も 1 つに収まる", () => {
    const https = buildAppConfig(bindings("https://takeoff-scheme.example.com"));
    const otherPort = buildAppConfig(bindings("https://takeoff-scheme.example.com:8443"));
    // http の local 環境
    const httpLocal = buildAppConfig(bindings("http://localhost:8787"));
    const httpsLocal = buildAppConfig(bindings("https://localhost:8787"));

    expect(otherPort.cacheBaseUrl).not.toBe(https.cacheBaseUrl);
    expect(httpLocal.cacheBaseUrl).not.toBe(httpsLocal.cacheBaseUrl);
    expect(new URL(httpLocal.cacheBaseUrl).pathname.split("/").filter(Boolean)).toHaveLength(1);
    // encodeURIComponent により host:port の ":" と "/" が segment を割らない
    const segments = new URL(https.cacheBaseUrl).pathname.split("/").filter(Boolean);
    expect(segments).toHaveLength(1);
    expect(new URL(otherPort.cacheBaseUrl).pathname.split("/").filter(Boolean)).toHaveLength(1);
  });

  it("同じ PUBLIC_BASE_URL から再構築した config は同じ Cache API entry に hit する", async () => {
    const firstConfig = buildAppConfig(bindings("https://takeoff-cache-hit.example.com/"));
    const secondConfig = buildAppConfig(bindings("https://takeoff-cache-hit.example.com"));
    const firstKey = cacheKeys.repoIndex(firstConfig.cacheBaseUrl);
    const secondKey = cacheKeys.repoIndex(secondConfig.cacheBaseUrl);
    const valueSchema = z.object({ value: z.literal("hit") });

    await workersCache.set(firstKey, { value: "hit" }, 60);

    expect(secondKey).toBe(firstKey);
    await expect(workersCache.get(secondKey, valueSchema)).resolves.toEqual({ value: "hit" });
  });
});
