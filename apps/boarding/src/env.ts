import { requiredString } from "@flightdeck/validation";

import type { BoardingMessage } from "./message/webhook.js";

export interface Env {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CHANNEL_ID?: string;
  DISCORD_WEBHOOK_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_BOT_USER_ID?: string;
  GITHUB_WEBHOOK_QUEUE: Queue<BoardingMessage>;
}

export const getDiscordCredentials = (env: Env): { token: string; channelId: string } => ({
  token: requiredString(env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN"),
  channelId: requiredString(env.DISCORD_CHANNEL_ID, "DISCORD_CHANNEL_ID"),
});

export const getDiscordWebhookUrl = (env: Env): string | undefined => {
  const value = env.DISCORD_WEBHOOK_URL?.trim();
  return value === "" ? undefined : value;
};

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
