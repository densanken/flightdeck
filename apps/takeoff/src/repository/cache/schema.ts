import { githubId, repositoryFullName } from "@flightdeck/validation";
import * as v from "valibot";

// 別 isolate や過去バージョンが書いた不正な cache は miss として扱う
const cachedPullRequestSchema = v.object({
  number: githubId,
  title: v.string(),
  htmlUrl: v.string(),
  authorLogin: v.string(),
  headRef: v.string(),
  baseRef: v.string(),
  updatedAt: v.string(),
});

export const cachedPullRequestListSchema = v.object({
  repoId: v.string(),
  items: v.array(cachedPullRequestSchema),
  fetchedAt: v.string(),
});

// cooldown は別 colo や過去バージョンが書いた値も検証する
export const mergeCooldownSchema = v.object({
  repoId: v.string(),
  prNumber: githubId,
  requestedAt: v.string(),
  requestedByDiscordUserId: v.string(),
});

export const syncCooldownSchema = v.object({
  repoId: v.string(),
  requestedAt: v.string(),
  requestedByDiscordUserId: v.string(),
});

// installation の一覧も Cache API から読み戻した値を検証する
const installationRepositorySummarySchema = v.object({
  id: githubId,
  owner: v.string(),
  name: v.string(),
  fullName: repositoryFullName,
  htmlUrl: v.string(),
});

export const cachedInstallationRepositoryListSchema = v.object({
  items: v.array(installationRepositorySummarySchema),
  fetchedAt: v.string(),
});
