import { ConfigurationError, optionalPositiveInteger, requiredId, requiredString } from "@flightdeck/validation";

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

export const getWebhookSecret = (env: Env): string =>
  requiredString(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET");

export const getGitHubAuthConfig = (env: Env): GitHubAuthConfig => ({
  appId: requiredString(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
  privateKeyPem: requiredString(env.GITHUB_PRIVATE_KEY, "GITHUB_PRIVATE_KEY"),
});

export const parseGitHubAppBotUserId = (value: string | undefined): number =>
  requiredId(value, "GITHUB_APP_BOT_USER_ID");

export const getRuntimeOptions = (env: Env): RuntimeOptions => {
  const deliveryCacheTtlSeconds = optionalPositiveInteger(
    env.DELIVERY_CACHE_TTL_SECONDS,
    "DELIVERY_CACHE_TTL_SECONDS",
    DEFAULT_DELIVERY_CACHE_TTL_SECONDS
  );

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
