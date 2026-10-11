import {
  cachedInstallationRepositoryListSchema,
  cachedPullRequestListSchema,
  mergeCooldownSchema,
  syncCooldownSchema,
} from "./interface.js";
import { repositoryIndexSchema } from "../../domain/repository.js";
import { cacheKeys } from "../../infrastructure/cache/keys.js";
import { memoryCache } from "../../infrastructure/cache/memory-cache.js";
import { workersCache } from "../../infrastructure/cache/workers-api.js";

import type {
  MergeCooldown,
  MergeCooldownStore,
  CachedInstallationRepositoryList,
  InstallationRepositoryCacheStore,
  SyncCooldown,
  SyncCooldownStore,
  RepoIndexCacheStore,
  PullRequestListCache,
} from "./interface.js";
import type { CachedPullRequestList } from "../../domain/pull-request.js";
import type { RepositoryIndex } from "../../domain/repository.js";
import type { z } from "zod";

const REPO_INDEX_MEMORY_CACHE_TTL_SECONDS = 300;

// fetchedAt を持つデータを memory へ載せ直すときの TTL
// 設定 TTL の残り時間と cap の小さい方を使い、期限切れ直前のデータを固定 TTL で memory に載せて実効 TTL が延びるのを防ぐ
// fetchedAt が不正な場合は 0 を返し、memory へ載せない
const rehydrateTtlFromFetchedAt =
  (configuredTtlSeconds: number, capSeconds: number) =>
  ({ fetchedAt }: { fetchedAt: string }): number => {
    const fetchedAtMs = Date.parse(fetchedAt);
    if (Number.isNaN(fetchedAtMs)) return 0;
    const remaining = configuredTtlSeconds - (Date.now() - fetchedAtMs) / 1000;
    return Math.min(capSeconds, remaining);
  };

interface TwoTierCacheOptions<T> {
  // 既定は ttlSeconds
  memoryTtlSeconds?: number;
  // Cache API の hit を memory へ載せ直す TTL
  // 未指定なら載せ直さない
  rehydrateTtlSeconds?: (value: T) => number;
}

// memory cache を先に引き、miss なら Cache API を schema で検証して読む
// 書き込みと削除は両方へ行う
class TwoTierCache<T> {
  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly ttlSeconds: number,
    private readonly options: TwoTierCacheOptions<T> = {}
  ) {}

  async get(key: string): Promise<T | null> {
    const memResult = memoryCache.get<T>(key);
    if (memResult) return memResult;

    const cacheResult = await workersCache.get(key, this.schema);
    if (cacheResult && this.options.rehydrateTtlSeconds) {
      memoryCache.set(key, cacheResult, this.options.rehydrateTtlSeconds(cacheResult));
    }
    return cacheResult;
  }

  async set(key: string, data: T): Promise<void> {
    memoryCache.set(key, data, this.options.memoryTtlSeconds ?? this.ttlSeconds);
    await workersCache.set(key, data, this.ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    memoryCache.delete(key);
    await workersCache.delete(key);
  }
}

export class CacheMergeCooldownStore implements MergeCooldownStore {
  private readonly cache: TwoTierCache<MergeCooldown>;

  constructor(
    private readonly cacheBaseUrl: string,
    ttlSeconds: number
  ) {
    this.cache = new TwoTierCache(mergeCooldownSchema, ttlSeconds);
  }

  get(repoId: string, prNumber: number): Promise<MergeCooldown | null> {
    return this.cache.get(cacheKeys.mergeCooldown(this.cacheBaseUrl, repoId, prNumber));
  }

  set(repoId: string, prNumber: number, data: MergeCooldown): Promise<void> {
    return this.cache.set(cacheKeys.mergeCooldown(this.cacheBaseUrl, repoId, prNumber), data);
  }

  delete(repoId: string, prNumber: number): Promise<void> {
    return this.cache.delete(cacheKeys.mergeCooldown(this.cacheBaseUrl, repoId, prNumber));
  }
}

export class CacheSyncCooldownStore implements SyncCooldownStore {
  private readonly cache: TwoTierCache<SyncCooldown>;

  constructor(
    private readonly cacheBaseUrl: string,
    ttlSeconds: number
  ) {
    this.cache = new TwoTierCache(syncCooldownSchema, ttlSeconds);
  }

  get(repoId: string): Promise<SyncCooldown | null> {
    return this.cache.get(cacheKeys.syncCooldown(this.cacheBaseUrl, repoId));
  }

  set(repoId: string, data: SyncCooldown): Promise<void> {
    return this.cache.set(cacheKeys.syncCooldown(this.cacheBaseUrl, repoId), data);
  }

  delete(repoId: string): Promise<void> {
    return this.cache.delete(cacheKeys.syncCooldown(this.cacheBaseUrl, repoId));
  }
}

export class CacheRepoIndexCacheStore implements RepoIndexCacheStore {
  private readonly cache: TwoTierCache<RepositoryIndex>;

  // Cache API は colo local のため、他拠点への反映が最大で TTL 分だけ遅れる
  // repository 管理は低頻度なので許容する即時反映が必要になった場合は Cache API 層を外し、KV と memory cache だけの構成へ変更する
  constructor(
    private readonly cacheBaseUrl: string,
    ttlSeconds: number
  ) {
    // RepositoryIndex には Cache API へ保存した時刻がない
    // hit を固定 TTL で memory へ載せ直すと元 entry の期限を越えて有効期間が延びるため、Cache API の期限をそのまま基準にする
    this.cache = new TwoTierCache(repositoryIndexSchema, ttlSeconds, {
      memoryTtlSeconds: Math.min(ttlSeconds, REPO_INDEX_MEMORY_CACHE_TTL_SECONDS),
    });
  }

  get(): Promise<RepositoryIndex | null> {
    return this.cache.get(cacheKeys.repoIndex(this.cacheBaseUrl));
  }

  set(data: RepositoryIndex): Promise<void> {
    return this.cache.set(cacheKeys.repoIndex(this.cacheBaseUrl), data);
  }

  invalidate(): Promise<void> {
    return this.cache.delete(cacheKeys.repoIndex(this.cacheBaseUrl));
  }
}

export class CacheInstallationRepositoryStore implements InstallationRepositoryCacheStore {
  private readonly cache: TwoTierCache<CachedInstallationRepositoryList>;

  constructor(
    private readonly cacheBaseUrl: string,
    ttlSeconds: number
  ) {
    this.cache = new TwoTierCache(cachedInstallationRepositoryListSchema, ttlSeconds, {
      rehydrateTtlSeconds: rehydrateTtlFromFetchedAt(ttlSeconds, 60),
    });
  }

  get(): Promise<CachedInstallationRepositoryList | null> {
    return this.cache.get(cacheKeys.installationRepositories(this.cacheBaseUrl));
  }

  set(data: CachedInstallationRepositoryList): Promise<void> {
    return this.cache.set(cacheKeys.installationRepositories(this.cacheBaseUrl), data);
  }
}

export class PullRequestListCacheImpl implements PullRequestListCache {
  private readonly cache: TwoTierCache<CachedPullRequestList>;

  constructor(
    private readonly cacheBaseUrl: string,
    ttlSeconds: number
  ) {
    this.cache = new TwoTierCache(cachedPullRequestListSchema, ttlSeconds, {
      rehydrateTtlSeconds: rehydrateTtlFromFetchedAt(ttlSeconds, 30),
    });
  }

  get(repoId: string): Promise<CachedPullRequestList | null> {
    return this.cache.get(cacheKeys.prList(this.cacheBaseUrl, repoId));
  }

  set(repoId: string, data: CachedPullRequestList): Promise<void> {
    return this.cache.set(cacheKeys.prList(this.cacheBaseUrl, repoId), data);
  }

  delete(repoId: string): Promise<void> {
    return this.cache.delete(cacheKeys.prList(this.cacheBaseUrl, repoId));
  }
}
