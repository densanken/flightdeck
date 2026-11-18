import { requiredString } from "@flightdeck/validation";

import type { BoardingMessage } from "./message/webhook.js";

export interface Env {
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_BOT_USER_ID?: string;
  GITHUB_WEBHOOK_QUEUE: Queue<BoardingMessage>;
}

export const getWebhookSecret = (env: Env): string =>
  requiredString(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET");

const positiveId = (raw: string | undefined, name: string): number => {
  const value = requiredString(raw, name);
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid ${name}`);

  return id;
};

export const getBotUserId = (env: Env): number => positiveId(env.GITHUB_APP_BOT_USER_ID, "GITHUB_APP_BOT_USER_ID");

export const getGitHubAppId = (env: Env): number => positiveId(env.GITHUB_APP_ID, "GITHUB_APP_ID");

export const getGitHubAppCredentials = (env: Env): { appId: string; privateKeyPem: string } => ({
  appId: String(getGitHubAppId(env)),
  privateKeyPem: requiredString(env.GITHUB_PRIVATE_KEY, "GITHUB_PRIVATE_KEY"),
});
