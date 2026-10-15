import { describe, expect, it, vi } from "vitest";

import { MockGitHubClient } from "./github.mock.js";
import { getPullRequestChecksForMergeGate } from "./pull-request-checks.js";
import { evaluateChecksAndStatusGate } from "../domain/merge-gate.js";

import type { GitHubPullRequest } from "./github.js";

const pullRequest: GitHubPullRequest = {
  number: 42,
  title: "feat: test",
  html_url: "https://github.com/org/repo/pull/42",
  state: "open",
  draft: false,
  mergeable: true,
  merge_commit_sha: "test-merge-sha",
  head: { sha: "head-sha", ref: "feature", label: "org:feature", repo: { id: 101 } },
  base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
  user: { login: "alice" },
  updated_at: "2024-01-01T00:00:00Z",
};

describe("getPullRequestChecksForMergeGate", () => {
  it("head SHA と test merge SHA の両方から取得し、どちらかの GHA run を認識する", async () => {
    const githubClient = new MockGitHubClient();
    const checkRunSpy = vi.spyOn(githubClient, "listCheckRunsForRef").mockImplementation((_token, _owner, _repo, ref) =>
      Promise.resolve({
        total_count: 1,
        check_runs: [
          {
            id: ref === "head-sha" ? 1 : 2,
            name: ref === "head-sha" ? "Bot" : "CI",
            status: "completed",
            conclusion: "success",
            html_url: null,
            app: { id: 123, slug: ref === "head-sha" ? "example-bot" : "github-actions" },
          },
        ],
      })
    );

    const result = await getPullRequestChecksForMergeGate(githubClient, "token", "org", "repo", pullRequest);

    expect(checkRunSpy.mock.calls.map((call) => call[3])).toEqual(["head-sha", "test-merge-sha"]);
    expect(result.checkRuns).toHaveLength(2);
    expect(evaluateChecksAndStatusGate(result.checkRuns, result.combinedStatus, null)).toEqual({ ok: true });
  });

  it("test merge SHA にある Bot/App failure を merge gate へ渡す", async () => {
    const githubClient = new MockGitHubClient();
    vi.spyOn(githubClient, "listCheckRunsForRef").mockImplementation((_token, _owner, _repo, ref) =>
      Promise.resolve({
        total_count: 1,
        check_runs: [
          {
            id: ref === "head-sha" ? 1 : 2,
            name: "CI",
            status: "completed",
            conclusion: ref === "test-merge-sha" ? "failure" : "success",
            html_url: null,
            app: { id: 123, slug: ref === "head-sha" ? "github-actions" : "example-bot" },
          },
        ],
      })
    );

    const result = await getPullRequestChecksForMergeGate(githubClient, "token", "org", "repo", pullRequest);

    expect(evaluateChecksAndStatusGate(result.checkRuns, result.combinedStatus, null)).toMatchObject({
      ok: false,
      error: { type: "checks_failed" },
    });
  });

  it("test merge SHA にある Commit Status failure を merge gate へ渡す", async () => {
    const githubClient = new MockGitHubClient();
    vi.spyOn(githubClient, "getCombinedStatusForRef").mockImplementation((_token, _owner, _repo, ref) =>
      Promise.resolve({
        state: ref === "test-merge-sha" ? "failure" : "success",
        total_count: ref === "test-merge-sha" ? 1 : 0,
        statuses: ref === "test-merge-sha" ? [{ state: "failure", context: "ci/test", target_url: null }] : [],
      })
    );

    const result = await getPullRequestChecksForMergeGate(githubClient, "token", "org", "repo", pullRequest);

    expect(result.combinedStatus.state).toBe("failure");
    expect(evaluateChecksAndStatusGate(result.checkRuns, result.combinedStatus, null)).toMatchObject({
      ok: false,
      error: { type: "statuses_failed" },
    });
  });
});
