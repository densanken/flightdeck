import { CONFIG_PATHS } from "@flightdeck/rules";

import { GitHubDataError } from "./errors.js";
import { blob } from "./schema.js";
import { normalizeActor, timelineItem } from "./timeline.js";

import type { PullRequest as ApiPullRequest } from "./schema.js";
import type { CheckRun, CommitStatus, PolicyPullRequest, PolicyReview } from "@flightdeck/rules";

const complete = (value: { totalCount: number; nodes: unknown[] }) => value.totalCount === value.nodes.length;

const readBlob = (value: unknown): string | null => {
  const parsed = blob.safeParse(value);

  return parsed.success && !parsed.data.isBinary && !parsed.data.isTruncated ? parsed.data.text : null;
};

export const normalizeConfigs = (files: { yml: unknown; yaml: unknown }) =>
  (
    [
      [CONFIG_PATHS.yml, files.yml],
      [CONFIG_PATHS.yaml, files.yaml],
    ] as const
  ).flatMap(([path, object]) => (object === null ? [] : [{ path, text: readBlob(object) }]));

export const normalizeReview = (review: ApiPullRequest["latestReviews"]["nodes"][number]): PolicyReview => ({
  id: review.databaseId ?? null,
  state: review.state,
  author: normalizeActor(review.author),
  commitOid: review.commit?.oid ?? null,
});

export const normalizePr = (pr: ApiPullRequest): PolicyPullRequest => {
  if (
    !complete(pr.labels) ||
    !complete(pr.files) ||
    !complete(pr.latestReviews) ||
    !complete(pr.latestOpinionatedReviews) ||
    pr.timelineItems.nodes.length !== pr.timelineItems.pageCount
  ) {
    throw new GitHubDataError("connection_truncated", "PR connection truncated");
  }

  // PR の query の取得中に push されたら、head に依存する項目がそろわない
  if (pr.commits.nodes.length !== 1 || pr.commits.nodes[0]?.commit.oid !== pr.headRefOid || !pr.baseRef) {
    throw new GitHubDataError("head_incomplete", "PR head incomplete");
  }

  const checks: CheckRun[] = [];
  const statuses: CommitStatus[] = [];

  for (const commit of [pr.commits.nodes[0].commit, pr.potentialMergeCommit]) {
    if (!commit) continue;

    const context = commit.statusCheckRollup?.contexts;
    if (!context) continue;
    if (!complete(context)) throw new GitHubDataError("connection_truncated", "CI contexts truncated");

    for (const item of context.nodes) {
      if (item.__typename === "CheckRun") {
        checks.push({
          name: item.name,
          status: item.status.toLowerCase(),
          conclusion: item.conclusion?.toLowerCase() ?? null,
          app:
            item.checkSuite.app?.databaseId == null
              ? null
              : { id: item.checkSuite.app.databaseId, slug: item.checkSuite.app.slug },
        });
      } else {
        statuses.push({
          context: item.context,
          state: item.state === "EXPECTED" ? "pending" : item.state.toLowerCase(),
        });
      }
    }
  }

  return {
    state: pr.state,
    draft: pr.isDraft,
    body: pr.body,
    createdAt: pr.createdAt,
    branch: pr.headRefName,
    headSha: pr.headRefOid,
    mergeSha: pr.potentialMergeCommit?.oid ?? null,
    baseBranch: pr.baseRefName,
    baseOid: pr.baseRef.target.oid,
    author: normalizeActor(pr.author),
    editor: normalizeActor(pr.editor),
    lastEditedAt: pr.lastEditedAt,
    headRepositoryId: pr.headRepository?.databaseId ?? null,
    labels: pr.labels.nodes.map((label) => label.name),
    files: pr.files.nodes,
    opinionatedReviews: pr.latestOpinionatedReviews.nodes.map(normalizeReview),
    reviews: pr.latestReviews.nodes.map(normalizeReview),
    timeline: pr.timelineItems.nodes.map(timelineItem),
    timelinePageCount: pr.timelineItems.pageCount,
    timelineHasPreviousPage: pr.timelineItems.pageInfo.hasPreviousPage,
    recentCount: pr.recent.pageCount,
    submodules: pr.baseRef.target.submodules.nodes,
    submodulesComplete: !pr.baseRef.target.submodules.pageInfo.hasNextPage,
    checks,
    statuses,
  };
};
