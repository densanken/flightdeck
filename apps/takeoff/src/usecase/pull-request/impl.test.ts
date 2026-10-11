import { describe, expect, it, vi } from "vitest";

import { PullRequestUsecaseImpl } from "./impl";
import { MockPullRequestListCache } from "./impl.mock";
import { MockGitHubClient } from "../github.mock";

import type { CachedPullRequest } from "../../domain/pull-request.js";
import type { GitHubPullRequestSummary } from "../github";

const makePr = (number: number, title: string, author: string): CachedPullRequest => ({
  number,
  title,
  htmlUrl: `https://github.com/org/repo/pull/${String(number)}`,
  authorLogin: author,
  headRef: "feature",
  baseRef: "main",
  updatedAt: "2024-01-01T00:00:00Z",
});

const tokenProvider = { getToken: vi.fn().mockResolvedValue("token") };

describe("listOpenPullRequests", () => {
  const githubPullRequest: GitHubPullRequestSummary = {
    number: 1,
    title: "feat: add login",
    html_url: "https://github.com/org/repo/pull/1",
    state: "open",
    draft: false,
    head: { sha: "head-sha", ref: "feature" },
    base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
    user: { login: "alice" },
    updated_at: "2024-01-01T00:00:00Z",
  };

  it("cache-only 取得は token や GitHub API を呼ばない", async () => {
    const cachedClient = new MockGitHubClient();
    const cachedCache = new MockPullRequestListCache();
    const cachedTokenProvider = { getToken: vi.fn().mockResolvedValue("token") };
    cachedCache.value = {
      repoId: "1",
      items: [makePr(1, "feat: cached", "alice")],
      fetchedAt: "2024-01-01T00:00:00Z",
    };
    const target = new PullRequestUsecaseImpl(cachedClient, cachedCache, cachedTokenProvider);

    await expect(target.getCachedPullRequestList("1")).resolves.toBe(cachedCache.value);

    expect(cachedTokenProvider.getToken).not.toHaveBeenCalled();
    expect(cachedClient.listOpenPullRequestsCalls).toBe(0);
  });

  it("cache hit 時は GitHub API を呼ばない", async () => {
    const hitClient = new MockGitHubClient();
    const hitCache = new MockPullRequestListCache();
    const hitTokenProvider = { getToken: vi.fn().mockResolvedValue("token") };
    hitCache.value = {
      repoId: "1",
      items: [makePr(1, "feat: cached", "alice")],
      fetchedAt: "2024-01-01T00:00:00Z",
    };
    const target = new PullRequestUsecaseImpl(hitClient, hitCache, hitTokenProvider);

    const result = await target.listOpenPullRequests("org", "repo", "1");

    expect(result).toBe(hitCache.value);
    expect(hitTokenProvider.getToken).not.toHaveBeenCalled();
    expect(hitClient.listOpenPullRequestsCalls).toBe(0);
  });

  it("cache miss 時は GitHub API を一度呼んで cache へ保存する", async () => {
    const missClient = new MockGitHubClient();
    missClient.pullRequestSummaries = [githubPullRequest];
    const missCache = new MockPullRequestListCache();
    const missTokenProvider = { getToken: vi.fn().mockResolvedValue("token") };
    const target = new PullRequestUsecaseImpl(missClient, missCache, missTokenProvider);

    const result = await target.listOpenPullRequests("org", "repo", "1");

    expect(result.items.at(0)?.number).toBe(1);
    expect(missTokenProvider.getToken).toHaveBeenCalledOnce();
    expect(missClient.listOpenPullRequestsCalls).toBe(1);
    expect(missCache.setCalls).toBe(1);
  });

  it("warming は既存 cache を使わず GitHub API から更新する", async () => {
    const warmClient = new MockGitHubClient();
    warmClient.pullRequestSummaries = [githubPullRequest];
    const warmCache = new MockPullRequestListCache();
    warmCache.value = {
      repoId: "1",
      items: [makePr(2, "fix: stale", "bob")],
      fetchedAt: "2024-01-01T00:00:00Z",
    };
    const target = new PullRequestUsecaseImpl(warmClient, warmCache, tokenProvider);

    const result = await target.warmPullRequestListCache("token", "org", "repo", "1");

    expect(result.items.at(0)?.number).toBe(1);
    expect(warmClient.listOpenPullRequestsCalls).toBe(1);
    expect(warmCache.setCalls).toBe(1);
  });
});
