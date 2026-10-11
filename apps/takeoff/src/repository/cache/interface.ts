import { z } from "zod";

import type { CachedPullRequest, CachedPullRequestList } from "../../domain/pull-request.js";
import type { RepositoryIndex } from "../../domain/repository.js";

// Cache API から読み戻した PR 一覧を検証する schema
export const cachedPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  htmlUrl: z.string(),
  authorLogin: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<CachedPullRequest>;

export const cachedPullRequestListSchema = z.object({
  repoId: z.string(),
  items: z.array(cachedPullRequestSchema),
  fetchedAt: z.string(),
}) satisfies z.ZodType<CachedPullRequestList>;

export interface PullRequestListCache {
  get(repoId: string): Promise<CachedPullRequestList | null>;
  set(repoId: string, data: CachedPullRequestList): Promise<void>;
  delete(repoId: string): Promise<void>;
}

export interface MergeCooldown {
  repoId: string;
  prNumber: number;
  requestedAt: string;
  requestedByDiscordUserId: string;
}

export interface MergeCooldownStore {
  get(repoId: string, prNumber: number): Promise<MergeCooldown | null>;
  set(repoId: string, prNumber: number, data: MergeCooldown): Promise<void>;
  delete(repoId: string, prNumber: number): Promise<void>;
}

// Cache API から読み戻した cooldown を検証する schema
export const mergeCooldownSchema = z.object({
  repoId: z.string(),
  prNumber: z.number().int(),
  requestedAt: z.string(),
  requestedByDiscordUserId: z.string(),
}) satisfies z.ZodType<MergeCooldown>;

export interface SyncCooldown {
  repoId: string;
  requestedAt: string;
  requestedByDiscordUserId: string;
}

export const syncCooldownSchema = z.object({
  repoId: z.string(),
  requestedAt: z.string(),
  requestedByDiscordUserId: z.string(),
}) satisfies z.ZodType<SyncCooldown>;

export interface SyncCooldownStore {
  get(repoId: string): Promise<SyncCooldown | null>;
  set(repoId: string, data: SyncCooldown): Promise<void>;
  delete(repoId: string): Promise<void>;
}

export interface RepoIndexCacheStore {
  get(): Promise<RepositoryIndex | null>;
  set(data: RepositoryIndex): Promise<void>;
  invalidate(): Promise<void>;
}

export interface InstallationRepositorySummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
}

export interface CachedInstallationRepositoryList {
  items: InstallationRepositorySummary[];
  fetchedAt: string;
}

// Cache API から読み戻した installation repository 一覧を検証する schema
export const installationRepositorySummarySchema = z.object({
  id: z.number().int(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  htmlUrl: z.string(),
}) satisfies z.ZodType<InstallationRepositorySummary>;

export const cachedInstallationRepositoryListSchema = z.object({
  items: z.array(installationRepositorySummarySchema),
  fetchedAt: z.string(),
}) satisfies z.ZodType<CachedInstallationRepositoryList>;

export interface InstallationRepositoryCacheStore {
  get(): Promise<CachedInstallationRepositoryList | null>;
  set(data: CachedInstallationRepositoryList): Promise<void>;
}
