import type { GitHubPullRequest } from "./github.js";

// fork（削除済みの head repository を含む）は所有者付きの label で区別する
export const getPullRequestHeadRef = (pr: GitHubPullRequest): string =>
  pr.head.repo?.id === pr.base.repo.id ? pr.head.ref : pr.head.label;
