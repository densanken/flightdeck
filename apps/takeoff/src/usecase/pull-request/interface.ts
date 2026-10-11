import type { CachedPullRequestList } from "../../domain/pull-request.js";

export interface PullRequestUsecase {
  getCachedPullRequestList(repoId: string): Promise<CachedPullRequestList | null>;

  listOpenPullRequests(owner: string, repo: string, repoId: string): Promise<CachedPullRequestList>;

  warmPullRequestListCache(token: string, owner: string, repo: string, repoId: string): Promise<CachedPullRequestList>;
}
