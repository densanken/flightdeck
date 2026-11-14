import { ConfigurationError } from "./errors.js";

export interface Env {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  DISPATCH_BOT_USER_ID?: string;
  RENOVATE_BOT_USER_IDS?: string;
  CLEARANCE_BOT_USER_ID?: string;
}

const required = (value: string | undefined, name: string): string => {
  if (!value) throw new ConfigurationError(`Runtime configuration is missing: ${name}`);

  return value;
};

const id = (value: string | undefined, name: string): number => {
  const text = required(value, name);
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number <= 0) {
    throw new ConfigurationError(`Invalid ${name}`);
  }

  return number;
};

export const getWebhookSecret = (env: Env): string => required(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET");

export const getMergeSettings = (env: Env) => ({
  appId: required(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
  privateKey: required(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
  dispatchId: id(env.DISPATCH_BOT_USER_ID, "DISPATCH_BOT_USER_ID"),
  botUserId: id(env.CLEARANCE_BOT_USER_ID, "CLEARANCE_BOT_USER_ID"),
  renovateIds: required(env.RENOVATE_BOT_USER_IDS, "RENOVATE_BOT_USER_IDS")
    .split(",")
    .map((value) => id(value.trim(), "RENOVATE_BOT_USER_IDS")),
});
