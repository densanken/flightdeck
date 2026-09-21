import { ConfigurationError } from "./errors.js";

import type { GitHubWebhookQueueMessage } from "./message/github-webhook.js";
import type { LogLevel } from "./util/logger.js";

export interface Env {
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_BOT_USER_ID?: string;
  DELIVERY_CACHE_TTL_SECONDS?: string;
  SKIP_BOTS?: string;
  LOG_LEVEL?: string;
  GITHUB_WEBHOOK_QUEUE?: Queue<GitHubWebhookQueueMessage>;
}

export interface RuntimeOptions {
  deliveryCacheTtlSeconds: number;
  skipBots: boolean;
  logLevel: LogLevel;
}

export interface GitHubAuthConfig {
  appId: string;
  privateKeyPem: string;
}

const DEFAULT_DELIVERY_CACHE_TTL_SECONDS = 86_400;

const requiredString = (value: string | undefined, key: string): string => {
  const normalized = value?.trim();
  if (!normalized) {
    throw new ConfigurationError(key, "missing");
  }
  return normalized;
};

export const getWebhookSecret = (env: Env): string => {
  if (!env.GITHUB_WEBHOOK_SECRET?.trim()) {
    throw new ConfigurationError("GITHUB_WEBHOOK_SECRET", "missing");
  }
  // HMAC は GitHub 側と同一の保存値そのままで計算するため、返り値は trim しない（存在判定だけ trim する）
  return env.GITHUB_WEBHOOK_SECRET;
};

export const getGitHubAuthConfig = (env: Env): GitHubAuthConfig => ({
  appId: requiredString(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
  privateKeyPem: requiredString(env.GITHUB_PRIVATE_KEY, "GITHUB_PRIVATE_KEY"),
});

export const parseGitHubAppBotUserId = (value: string | undefined): number => {
  const normalized = value?.trim();
  if (!normalized) throw new ConfigurationError("GITHUB_APP_BOT_USER_ID", "missing");
  if (!/^\d+$/.test(normalized)) throw new ConfigurationError("GITHUB_APP_BOT_USER_ID", "invalid");
  const userId = Number(normalized);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new ConfigurationError("GITHUB_APP_BOT_USER_ID", "invalid");
  }
  return userId;
};

export const getRuntimeOptions = (env: Env): RuntimeOptions => {
  const ttlValue = env.DELIVERY_CACHE_TTL_SECONDS?.trim();
  const deliveryCacheTtlSeconds =
    ttlValue === undefined || ttlValue === "" ? DEFAULT_DELIVERY_CACHE_TTL_SECONDS : Number(ttlValue);
  if (!Number.isSafeInteger(deliveryCacheTtlSeconds) || deliveryCacheTtlSeconds <= 0) {
    throw new ConfigurationError("DELIVERY_CACHE_TTL_SECONDS", "invalid");
  }

  const skipBotsValue = env.SKIP_BOTS?.trim().toLowerCase() ?? "true";
  if (skipBotsValue !== "true" && skipBotsValue !== "false") {
    throw new ConfigurationError("SKIP_BOTS", "invalid");
  }

  const logLevel = env.LOG_LEVEL?.trim().toLowerCase() ?? "info";
  if (logLevel !== "debug" && logLevel !== "info" && logLevel !== "warn" && logLevel !== "error") {
    throw new ConfigurationError("LOG_LEVEL", "invalid");
  }

  return {
    deliveryCacheTtlSeconds,
    skipBots: skipBotsValue === "true",
    logLevel,
  };
};
