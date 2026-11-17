import { ConfigurationError, requiredString } from "@flightdeck/validation";

import { buildAppConfig } from "./config.js";

export interface Env {
  Bindings: {
    // secret
    GITHUB_APP_PRIVATE_KEY: string;
    DISCORD_PUBLIC_KEY: string;
    DISCORD_APPLICATION_ID: string;
    MERGE_AUDIT_DISCORD_WEBHOOK_URL: string;
    GITHUB_WEBHOOK_SECRET?: string;

    // 環境変数
    GITHUB_APP_ID: string;
    GITHUB_ORG: string;
    ALLOWED_GUILD_IDS: string;
    ADMIN_ROLE_IDS: string;
    PUBLIC_BASE_URL: string;
    PR_LIST_CACHE_TTL_SECONDS?: string;
    REPO_INDEX_CACHE_TTL_SECONDS?: string;
    MERGE_COOLDOWN_SECONDS?: string;
    SYNC_COOLDOWN_SECONDS?: string;
    INSTALLATION_REPO_CACHE_TTL_SECONDS?: string;

    // binding
    KV: KVNamespace;
  };
}

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

const requiredStringKeys = [
  "GITHUB_APP_PRIVATE_KEY",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APPLICATION_ID",
  "MERGE_AUDIT_DISCORD_WEBHOOK_URL",
  "GITHUB_APP_ID",
  "GITHUB_ORG",
  "ALLOWED_GUILD_IDS",
  "ADMIN_ROLE_IDS",
  "PUBLIC_BASE_URL",
] as const;

export const validateEnv = (bindings: Env["Bindings"]): void => {
  try {
    for (const key of requiredStringKeys) requiredString(bindings[key], key);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    throw new EnvValidationError(`Required environment variable is missing: ${error.configKey}`);
  }

  // origin が "null" になる値を cache namespace に使わないよう、http(s) の URL だけを受け付ける
  const publicBaseUrlProtocol = URL.parse(bindings.PUBLIC_BASE_URL)?.protocol;
  if (publicBaseUrlProtocol !== "http:" && publicBaseUrlProtocol !== "https:") {
    throw new EnvValidationError("PUBLIC_BASE_URL must be a valid http(s) URL");
  }

  if (URL.parse(bindings.MERGE_AUDIT_DISCORD_WEBHOOK_URL)?.protocol !== "https:") {
    throw new EnvValidationError("MERGE_AUDIT_DISCORD_WEBHOOK_URL must be a valid https URL");
  }

  if (parseCommaSeparated(bindings.ALLOWED_GUILD_IDS).length === 0) {
    throw new EnvValidationError("ALLOWED_GUILD_IDS must contain at least one guild ID");
  }
  if (parseCommaSeparated(bindings.ADMIN_ROLE_IDS).length === 0) {
    throw new EnvValidationError("ADMIN_ROLE_IDS must contain at least one role ID");
  }

  try {
    buildAppConfig(bindings);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    throw new EnvValidationError(`${error.configKey} must be a positive integer`);
  }
};

export const parseCommaSeparated = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const getWebhookSecret = (bindings: Env["Bindings"]): string =>
  requiredString(bindings.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET");
