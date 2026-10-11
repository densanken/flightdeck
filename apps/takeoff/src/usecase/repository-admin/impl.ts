import { AppError } from "../../domain/errors.js";
import { nowIso } from "../../domain/time.js";
import { errorDetail } from "../../util/error-detail.js";

import type { RepositoryAdminUsecase, RepositoryReconcileResult } from "./interface.js";
import type { RegisteredRepository, RepositoryIndex } from "../../domain/repository.js";
import type {
  CachedInstallationRepositoryList,
  InstallationRepositoryCacheStore,
  PullRequestListCache,
  RepoIndexCacheStore,
} from "../../repository/cache/interface.js";
import type { RegisteredRepositoryStore } from "../../repository/kv/interface.js";
import type { GitHubClient, GitHubRepository, InstallationTokenProvider } from "../github.js";
import type { PullRequestUsecase } from "../pull-request/interface.js";

export class RepositoryAdminUsecaseImpl implements RepositoryAdminUsecase {
  constructor(
    private readonly githubClient: GitHubClient,
    private readonly tokenProvider: InstallationTokenProvider,
    private readonly repoStore: RegisteredRepositoryStore,
    private readonly repoIndexCache: RepoIndexCacheStore,
    private readonly installationRepositoryCache: InstallationRepositoryCacheStore,
    private readonly pullRequestUsecase: PullRequestUsecase,
    private readonly pullRequestListCache: PullRequestListCache
  ) {}

  async addRepository(owner: string, name: string): Promise<RegisteredRepository> {
    const token = await this.tokenProvider.getToken();
    const gitHubRepository = await this.githubClient.getRepository(token, owner, name);

    const now = nowIso();
    const registered: RegisteredRepository = {
      repoId: String(gitHubRepository.id),
      owner: gitHubRepository.owner.login,
      name: gitHubRepository.name,
      fullName: gitHubRepository.full_name,
      htmlUrl: gitHubRepository.html_url,
      createdAt: now,
      updatedAt: now,
    };

    const index = await this.repoStore.addRepository(registered);
    await this.setRepoIndexCache(index);

    try {
      await this.pullRequestUsecase.warmPullRequestListCache(
        token,
        registered.owner,
        registered.name,
        registered.repoId
      );
    } catch {
      // PR 一覧 cache の事前構築に失敗しても登録自体は完了しているため、error を無視する
    }

    return registered;
  }

  async removeRepository(repoId: string): Promise<boolean> {
    const index = await this.repoStore.removeRepository(repoId);
    if (index === null) return false;

    await this.setRepoIndexCache(index);
    try {
      await this.pullRequestListCache.delete(repoId);
    } catch (error) {
      console.error("pr_list_cache_invalidate_failed", { repoId, error: errorDetail(error) });
    }
    return true;
  }

  getRepository(repoId: string): Promise<RegisteredRepository | null> {
    return this.repoStore.getRepository(repoId);
  }

  async reconcileRepository(repoId: string, githubOrg: string): Promise<RepositoryReconcileResult> {
    const registered = await this.repoStore.getRepository(repoId);
    if (!registered) return { type: "not_registered" };

    // installation から消えた repository は 404 になるため、応答なしを null で表す
    let gitHubRepository: GitHubRepository | null;
    try {
      const token = await this.tokenProvider.getToken();
      gitHubRepository = await this.githubClient.getRepositoryById(token, Number(repoId));
    } catch (error) {
      if (!(error instanceof AppError && error.type === "repo_not_found")) throw error;
      gitHubRepository = null;
    }

    // installation から消えた、または org 外へ transfer 済みなら登録解除する
    if (gitHubRepository?.owner.login.toLowerCase() !== githubOrg.toLowerCase()) {
      await this.removeRepositoryForReconcile(repoId);
      return { type: "removed" };
    }

    const synchronized = {
      ...registered,
      owner: gitHubRepository.owner.login,
      name: gitHubRepository.name,
      fullName: gitHubRepository.full_name,
      htmlUrl: gitHubRepository.html_url,
      updatedAt: nowIso(),
    };
    await this.repoStore.updateRepositoryMetadata(synchronized);
    // remove が更新した index を古い snapshot で上書きしない
    await this.repoIndexCache.invalidate();
    await this.pullRequestListCache.delete(repoId);
    return { type: "synchronized", repository: synchronized };
  }

  async getRepositoryIndex(): Promise<RepositoryIndex> {
    const cached = await this.repoIndexCache.get();
    if (cached) return cached;

    const index = await this.repoStore.getRepositoryIndex();
    await this.repoIndexCache.set(index);
    return index;
  }

  getCachedRepositoryIndex(): Promise<RepositoryIndex | null> {
    return this.repoIndexCache.get();
  }

  async getInstallationRepositories(): Promise<CachedInstallationRepositoryList> {
    const token = await this.tokenProvider.getToken();
    const repositories = await this.githubClient.listInstallationRepositories(token);
    const result: CachedInstallationRepositoryList = {
      items: repositories.map((repository) => ({
        id: repository.id,
        owner: repository.owner.login,
        name: repository.name,
        fullName: repository.full_name,
        htmlUrl: repository.html_url,
      })),
      fetchedAt: nowIso(),
    };
    await this.installationRepositoryCache.set(result);
    return result;
  }

  getCachedInstallationRepositories(): Promise<CachedInstallationRepositoryList | null> {
    return this.installationRepositoryCache.get();
  }

  // KV list は put/delete 直後に古い場合があるため、add/remove が対象 item を明示的に
  // 加えた、または除いた返り値をそのまま cache へ書く
  private async setRepoIndexCache(index: RepositoryIndex): Promise<void> {
    await this.repoIndexCache.invalidate();
    await this.repoIndexCache.set(index);
  }

  private async removeRepositoryForReconcile(repoId: string): Promise<void> {
    const index = await this.repoStore.removeRepository(repoId);
    if (index === null) return;
    await this.setRepoIndexCache(index);
    await this.pullRequestListCache.delete(repoId);
  }
}
