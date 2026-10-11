export interface Env {
  Bindings: {
    // secret
    GITHUB_APP_PRIVATE_KEY: string;
    DISCORD_PUBLIC_KEY: string;
    DISCORD_APPLICATION_ID: string;
    DISCORD_BOT_TOKEN: string;
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

export const DEFAULT_PR_LIST_CACHE_TTL_SECONDS = 60;
// repo-index の Cache API entry は colo local のため、この TTL がそのまま他拠点への反映遅延の上限になる
export const DEFAULT_REPO_INDEX_CACHE_TTL_SECONDS = 300;
export const DEFAULT_MERGE_COOLDOWN_SECONDS = 10;
export const DEFAULT_SYNC_COOLDOWN_SECONDS = 30;
export const DEFAULT_INSTALLATION_REPO_CACHE_TTL_SECONDS = 60;

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
  "DISCORD_BOT_TOKEN",
  "MERGE_AUDIT_DISCORD_WEBHOOK_URL",
  "GITHUB_APP_ID",
  "GITHUB_ORG",
  "ALLOWED_GUILD_IDS",
  "ADMIN_ROLE_IDS",
  "PUBLIC_BASE_URL",
] as const;

const optionalPositiveIntegerKeys = [
  "PR_LIST_CACHE_TTL_SECONDS",
  "REPO_INDEX_CACHE_TTL_SECONDS",
  "MERGE_COOLDOWN_SECONDS",
  "SYNC_COOLDOWN_SECONDS",
  "INSTALLATION_REPO_CACHE_TTL_SECONDS",
] as const;

export const validateEnv = (bindings: Env["Bindings"]): void => {
  for (const key of requiredStringKeys) {
    if (!(bindings[key] as string | undefined)?.trim()) {
      throw new EnvValidationError(`Required environment variable is missing: ${key}`);
    }
  }

  // origin が "null" になる値を cache namespace に使わないよう、http(s) の URL だけを受け付ける
  const publicBaseUrlProtocol = URL.parse(bindings.PUBLIC_BASE_URL)?.protocol;
  if (publicBaseUrlProtocol !== "http:" && publicBaseUrlProtocol !== "https:") {
    throw new EnvValidationError("PUBLIC_BASE_URL must be a valid http(s) URL");
  }

  let mergeAuditWebhookUrl: URL;
  try {
    mergeAuditWebhookUrl = new URL(bindings.MERGE_AUDIT_DISCORD_WEBHOOK_URL);
  } catch {
    throw new EnvValidationError("MERGE_AUDIT_DISCORD_WEBHOOK_URL must be a valid Discord Webhook URL");
  }
  if (
    mergeAuditWebhookUrl.origin !== "https://discord.com" ||
    !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(mergeAuditWebhookUrl.pathname) ||
    mergeAuditWebhookUrl.search !== "" ||
    mergeAuditWebhookUrl.hash !== "" ||
    mergeAuditWebhookUrl.username !== "" ||
    mergeAuditWebhookUrl.password !== ""
  ) {
    throw new EnvValidationError(
      "MERGE_AUDIT_DISCORD_WEBHOOK_URL must use https://discord.com/api/webhooks/{id}/{token}"
    );
  }

  for (const key of optionalPositiveIntegerKeys) {
    const value = bindings[key];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || Number.parseInt(value, 10) <= 0) {
      throw new EnvValidationError(`${key} must be a positive integer`);
    }
  }

  if (parseCommaSeparated(bindings.ALLOWED_GUILD_IDS).length === 0) {
    throw new EnvValidationError("ALLOWED_GUILD_IDS must contain at least one guild ID");
  }
  if (parseCommaSeparated(bindings.ADMIN_ROLE_IDS).length === 0) {
    throw new EnvValidationError("ADMIN_ROLE_IDS must contain at least one role ID");
  }
};

export const parseCommaSeparated = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const parseIntWithDefault = (value: string | undefined, defaultValue: number): number => {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};
