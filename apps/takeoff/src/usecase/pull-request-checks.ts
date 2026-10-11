import type { GitHubClient, GitHubPullRequest } from "./github.js";

export const getPullRequestChecksForMergeGate = async (
  githubClient: GitHubClient,
  token: string,
  owner: string,
  repo: string,
  pullRequest: GitHubPullRequest
) => {
  // GitHub Actions pull_request workflows report on the test merge commit; push workflows report on the head commit.
  // Check both so either workflow trigger can satisfy the GHA presence gate and failures on both refs are visible.
  const refs = Array.from(
    new Set(
      [pullRequest.head.sha, pullRequest.merge_commit_sha].filter(
        (ref): ref is string => typeof ref === "string" && ref.length > 0
      )
    )
  );
  const results = await Promise.all(
    refs.map(async (ref) => {
      const [checkRuns, combinedStatus] = await Promise.all([
        githubClient.listCheckRunsForRef(token, owner, repo, ref),
        githubClient.getCombinedStatusForRef(token, owner, repo, ref),
      ]);
      return { checkRuns, combinedStatus };
    })
  );
  const statusResponses = results.map((result) => result.combinedStatus);
  const statuses = statusResponses.flatMap((result) => result.statuses);
  const responsesWithStatuses = statusResponses.filter((result) => result.statuses.length > 0);
  const hasFailure =
    responsesWithStatuses.some((result) => result.state !== "success" && result.state !== "pending") ||
    statuses.some((status) => status.state !== "success" && status.state !== "pending");
  const hasPending =
    responsesWithStatuses.some((result) => result.state === "pending") ||
    statuses.some((status) => status.state === "pending");

  return {
    checkRuns: results.flatMap((result) => result.checkRuns.check_runs),
    combinedStatus: {
      state: hasFailure ? "failure" : hasPending ? "pending" : "success",
      total_count: statusResponses.reduce((total, result) => total + result.total_count, 0),
      statuses,
    },
  };
};
