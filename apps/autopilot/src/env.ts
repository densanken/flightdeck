import { requiredId, requiredIdList, requiredString } from "@flightdeck/validation";

export interface Env {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  DISPATCH_BOT_USER_ID?: string;
  RENOVATE_BOT_USER_IDS?: string;
  CLEARANCE_BOT_USER_ID?: string;
}

export const getWebhookSecret = (env: Env): string =>
  requiredString(env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET");

export const getMergeSettings = (env: Env) => ({
  appId: requiredString(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
  privateKey: requiredString(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
  dispatchId: requiredId(env.DISPATCH_BOT_USER_ID, "DISPATCH_BOT_USER_ID"),
  botUserId: requiredId(env.CLEARANCE_BOT_USER_ID, "CLEARANCE_BOT_USER_ID"),
  renovateIds: requiredIdList(env.RENOVATE_BOT_USER_IDS, "RENOVATE_BOT_USER_IDS"),
});
