import {
  DEFAULT_INSTALLATION_REPO_CACHE_TTL_SECONDS,
  DEFAULT_MERGE_COOLDOWN_SECONDS,
  DEFAULT_PR_LIST_CACHE_TTL_SECONDS,
  DEFAULT_REPO_INDEX_CACHE_TTL_SECONDS,
  DEFAULT_SYNC_COOLDOWN_SECONDS,
  parseIntWithDefault,
} from "./env.js";

import type { Env } from "./env.js";

export interface AppConfig {
  cacheBaseUrl: string;
  githubOrg: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  mergeAuditWebhookUrl: string;
  prListCacheTtlSeconds: number;
  repoIndexCacheTtlSeconds: number;
  mergeCooldownSeconds: number;
  syncCooldownSeconds: number;
  installationRepoCacheTtlSeconds: number;
}

// cache key の origin を到達不能な内部 origin にし、実在しうる公開 URL と cache key を一致させない
// これは公開 endpoint と cache の URL 空間を分けるためのものであり、同一 zone の他 Worker に対する秘匿ではない
// key は定数と公開情報と repository ID だけで決まるため、Cache API を読める Worker は key を再現できる
// Cache API に置く値は、読まれても許容できるものに限る
// （installation token を Cache API へ置かず memory cache に限定しているのはこのため）
export const CACHE_KEY_ORIGIN = "https://takeoff.internal";

// 環境ごとの分離は PUBLIC_BASE_URL の正規化 origin を path segment に混ぜて維持する
// origin は URL が host の大文字小文字と既定 port を正規化するため、同じ環境なら同じ segment になる
export const buildCacheBaseUrl = (publicBaseUrl: string): string =>
  `${CACHE_KEY_ORIGIN}/${encodeURIComponent(publicBaseUrl)}`;

export const buildAppConfig = (env: Env["Bindings"]): AppConfig => {
  // "https://example.com/" のような末尾スラッシュを origin へ正規化する
  const publicBaseUrl = new URL(env.PUBLIC_BASE_URL).origin;
  return {
    cacheBaseUrl: buildCacheBaseUrl(publicBaseUrl),
    githubOrg: env.GITHUB_ORG,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    mergeAuditWebhookUrl: env.MERGE_AUDIT_DISCORD_WEBHOOK_URL,
    prListCacheTtlSeconds: parseIntWithDefault(env.PR_LIST_CACHE_TTL_SECONDS, DEFAULT_PR_LIST_CACHE_TTL_SECONDS),
    repoIndexCacheTtlSeconds: parseIntWithDefault(
      env.REPO_INDEX_CACHE_TTL_SECONDS,
      DEFAULT_REPO_INDEX_CACHE_TTL_SECONDS
    ),
    mergeCooldownSeconds: parseIntWithDefault(env.MERGE_COOLDOWN_SECONDS, DEFAULT_MERGE_COOLDOWN_SECONDS),
    syncCooldownSeconds: parseIntWithDefault(env.SYNC_COOLDOWN_SECONDS, DEFAULT_SYNC_COOLDOWN_SECONDS),
    installationRepoCacheTtlSeconds: parseIntWithDefault(
      env.INSTALLATION_REPO_CACHE_TTL_SECONDS,
      DEFAULT_INSTALLATION_REPO_CACHE_TTL_SECONDS
    ),
  };
};
