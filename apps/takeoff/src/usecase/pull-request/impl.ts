import { toCachedPullRequestList } from "./mapper.js";

import type { PullRequestUsecase } from "./interface.js";
import type { CachedPullRequestList } from "../../domain/pull-request.js";
import type { PullRequestListCache } from "../../repository/cache/interface.js";
import type { GitHubClient, InstallationTokenProvider } from "../github.js";

export class PullRequestUsecaseImpl implements PullRequestUsecase {
  constructor(
    private readonly client: GitHubClient,
    private readonly cache: PullRequestListCache,
    private readonly tokenProvider: InstallationTokenProvider
  ) {}

  getCachedPullRequestList(repoId: string): Promise<CachedPullRequestList | null> {
    return this.cache.get(repoId);
  }

  async listOpenPullRequests(owner: string, repo: string, repoId: string): Promise<CachedPullRequestList> {
    const cached = await this.cache.get(repoId);
    if (cached) return cached;

    const token = await this.tokenProvider.getToken();
    const prs = await this.client.listOpenPullRequests(token, owner, repo);
    const result = toCachedPullRequestList(repoId, prs);
    await this.cache.set(repoId, result);
    return result;
  }

  async warmPullRequestListCache(
    token: string,
    owner: string,
    repo: string,
    repoId: string
  ): Promise<CachedPullRequestList> {
    const prs = await this.client.listOpenPullRequests(token, owner, repo);
    const result = toCachedPullRequestList(repoId, prs);
    await this.cache.set(repoId, result);
    return result;
  }
}
