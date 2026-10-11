import { buildAppConfig } from "../config.js";
import { DiscordMergeAuditNotifier } from "../infrastructure/discord/webhook-client.js";
import { githubAppAuth } from "../infrastructure/github/app-auth.js";
import { GitHubClientImpl } from "../infrastructure/github/client.js";
import {
  CacheInstallationRepositoryStore,
  CacheMergeCooldownStore,
  CacheRepoIndexCacheStore,
  CacheSyncCooldownStore,
  PullRequestListCacheImpl,
} from "../repository/cache/impl.js";
import { KvRegisteredRepositoryStore } from "../repository/kv/impl.js";
import { AutoApproveUsecaseImpl } from "../usecase/auto-approve/impl.js";
import { MergeUsecaseImpl } from "../usecase/merge/impl.js";
import { PullRequestUsecaseImpl } from "../usecase/pull-request/impl.js";
import { RepositoryAdminUsecaseImpl } from "../usecase/repository-admin/impl.js";
import { StatusUsecaseImpl } from "../usecase/status/impl.js";
import { SyncUsecaseImpl } from "../usecase/sync/impl.js";

import type { Env } from "../env.js";
import type {
  InstallationRepositoryCacheStore,
  MergeCooldownStore,
  PullRequestListCache,
  RepoIndexCacheStore,
  SyncCooldownStore,
} from "../repository/cache/interface.js";
import type { RegisteredRepositoryStore } from "../repository/kv/interface.js";
import type { AutoApproveUsecase } from "../usecase/auto-approve/interface.js";
import type { GitHubClient, InstallationTokenProvider } from "../usecase/github.js";
import type { MergeAuditNotifier, MergeUsecase } from "../usecase/merge/interface.js";
import type { PullRequestUsecase } from "../usecase/pull-request/interface.js";
import type { RepositoryAdminUsecase } from "../usecase/repository-admin/interface.js";
import type { StatusUsecase } from "../usecase/status/interface.js";
import type { SyncUsecase } from "../usecase/sync/interface.js";

export interface DependencyGraph {
  githubClient: GitHubClient;
  tokenProvider: InstallationTokenProvider;
  repoStore: RegisteredRepositoryStore;
  mergeCooldownCache: MergeCooldownStore;
  syncCooldownCache: SyncCooldownStore;
  repoIndexCache: RepoIndexCacheStore;
  installationRepositoryCache: InstallationRepositoryCacheStore;
  pullRequestListCache: PullRequestListCache;
  auditNotifier: MergeAuditNotifier;
  autoApproveUsecase: AutoApproveUsecase;
  pullRequestUsecase: PullRequestUsecase;
  mergeUsecase: MergeUsecase;
  statusUsecase: StatusUsecase;
  repositoryAdminUsecase: RepositoryAdminUsecase;
  syncUsecase: SyncUsecase;
}

export const composeDependencyGraph = (env: Env["Bindings"]): DependencyGraph => {
  const config = buildAppConfig(env);
  const githubClient = new GitHubClientImpl();
  const tokenProvider: InstallationTokenProvider = {
    getToken: () =>
      githubAppAuth.getAuthenticatedToken(
        config.githubAppId,
        config.githubAppPrivateKey,
        config.githubOrg,
        config.cacheBaseUrl
      ),
  };
  const repoStore = new KvRegisteredRepositoryStore(env.KV);
  const mergeCooldownCache = new CacheMergeCooldownStore(config.cacheBaseUrl, config.mergeCooldownSeconds);
  const syncCooldownCache = new CacheSyncCooldownStore(config.cacheBaseUrl, config.syncCooldownSeconds);
  const repoIndexCache = new CacheRepoIndexCacheStore(config.cacheBaseUrl, config.repoIndexCacheTtlSeconds);
  const installationRepositoryCache = new CacheInstallationRepositoryStore(
    config.cacheBaseUrl,
    config.installationRepoCacheTtlSeconds
  );
  const pullRequestListCache = new PullRequestListCacheImpl(config.cacheBaseUrl, config.prListCacheTtlSeconds);
  const auditNotifier = new DiscordMergeAuditNotifier(config.mergeAuditWebhookUrl);
  const autoApproveUsecase = new AutoApproveUsecaseImpl(githubClient, tokenProvider, repoStore, config.githubOrg);
  const pullRequestUsecase = new PullRequestUsecaseImpl(githubClient, pullRequestListCache, tokenProvider);
  const mergeUsecase = new MergeUsecaseImpl(
    githubClient,
    tokenProvider,
    repoStore,
    mergeCooldownCache,
    pullRequestUsecase,
    auditNotifier,
    autoApproveUsecase
  );
  const statusUsecase = new StatusUsecaseImpl(githubClient, tokenProvider, repoStore, autoApproveUsecase);
  const repositoryAdminUsecase = new RepositoryAdminUsecaseImpl(
    githubClient,
    tokenProvider,
    repoStore,
    repoIndexCache,
    installationRepositoryCache,
    pullRequestUsecase,
    pullRequestListCache
  );
  const syncUsecase = new SyncUsecaseImpl(tokenProvider, syncCooldownCache, pullRequestUsecase);

  return {
    githubClient,
    tokenProvider,
    repoStore,
    mergeCooldownCache,
    syncCooldownCache,
    repoIndexCache,
    installationRepositoryCache,
    pullRequestListCache,
    auditNotifier,
    autoApproveUsecase,
    pullRequestUsecase,
    mergeUsecase,
    statusUsecase,
    repositoryAdminUsecase,
    syncUsecase,
  };
};
