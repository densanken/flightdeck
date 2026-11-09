import type { DispatchMessage } from "./message/webhook.js";

export interface Env {
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // wrangler.jsonc の binding で必ず渡される
  GITHUB_WEBHOOK_QUEUE: Queue<DispatchMessage>;
}

const required = <T>(value: T | undefined, key: string): T => {
  if (value === undefined || value === "") throw new Error(`Runtime configuration is missing: ${key}`);

  return value;
};

export const getWebhookSecret = (env: Env): string => required(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET");

export const getGitHubAppCredentials = (env: Env): { appId: string; privateKeyPem: string } => ({
  appId: required(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
  privateKeyPem: required(env.GITHUB_PRIVATE_KEY, "GITHUB_PRIVATE_KEY"),
});
