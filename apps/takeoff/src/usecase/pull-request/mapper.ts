import type { CachedPullRequestList } from "../../domain/pull-request.js";
import type { GitHubPullRequestSummary } from "../github.js";

export const toCachedPullRequestList = (repoId: string, prs: GitHubPullRequestSummary[]): CachedPullRequestList => ({
  repoId,
  items: prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    authorLogin: pr.user?.login ?? "unknown",
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    updatedAt: pr.updated_at,
  })),
  fetchedAt: new Date().toISOString(),
});
