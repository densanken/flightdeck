import type { PullRequestUsecase } from "./interface.js";
import type { CachedPullRequest, CachedPullRequestList } from "../../domain/pull-request.js";
import type { PullRequestListCache } from "../../repository/cache/interface.js";

export class MockPullRequestListCache implements PullRequestListCache {
  value: CachedPullRequestList | null = null;
  getCalls = 0;
  setCalls = 0;
  deleteCalls = 0;

  get(_repoId: string): Promise<CachedPullRequestList | null> {
    this.getCalls += 1;
    return Promise.resolve(this.value);
  }

  set(_repoId: string, data: CachedPullRequestList): Promise<void> {
    this.setCalls += 1;
    this.value = data;
    return Promise.resolve();
  }

  delete(_repoId: string): Promise<void> {
    this.deleteCalls += 1;
    this.value = null;
    return Promise.resolve();
  }
}

export class MockPullRequestUsecase implements PullRequestUsecase {
  constructor(private pullRequests: CachedPullRequest[] = []) {}

  getCachedPullRequestList(_repoId: string): Promise<CachedPullRequestList | null> {
    return Promise.resolve(null);
  }

  listOpenPullRequests(_owner: string, _repo: string, repoId: string): Promise<CachedPullRequestList> {
    return Promise.resolve({
      repoId,
      items: this.pullRequests,
      fetchedAt: new Date().toISOString(),
    });
  }

  warmPullRequestListCache(
    _token: string,
    _owner: string,
    _repo: string,
    repoId: string
  ): Promise<CachedPullRequestList> {
    return Promise.resolve({
      repoId,
      items: this.pullRequests,
      fetchedAt: new Date().toISOString(),
    });
  }
}
