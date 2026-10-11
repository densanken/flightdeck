export interface CachedPullRequest {
  number: number;
  title: string;
  htmlUrl: string;
  authorLogin: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
}

export interface CachedPullRequestList {
  repoId: string;
  items: CachedPullRequest[];
  fetchedAt: string;
}
