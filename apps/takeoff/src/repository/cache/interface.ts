import type { CachedPullRequestList } from "../../domain/pull-request.js";
import type { RepositoryIndex } from "../../domain/repository.js";

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

export interface SyncCooldown {
  repoId: string;
  requestedAt: string;
  requestedByDiscordUserId: string;
}

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

export interface InstallationRepositoryCacheStore {
  get(): Promise<CachedInstallationRepositoryList | null>;
  set(data: CachedInstallationRepositoryList): Promise<void>;
}
