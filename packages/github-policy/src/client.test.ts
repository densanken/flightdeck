import { describe, expect, it, vi } from "vitest";

import { GitHubPolicyGatewayImpl } from "./client.js";
import { ApiError } from "./errors.js";

import type { GitHubRequest } from "./request.js";

const client = () => {
  const graphql = vi.fn<(query: string, variables: Record<string, unknown>) => Promise<unknown>>();
  const request =
    vi.fn<(path: string, method?: string, body?: unknown) => Promise<{ data: unknown; response: Response }>>();
  return {
    graphql,
    request,
    github: new GitHubPolicyGatewayImpl({ graphql, request } as unknown as GitHubRequest, "org/repo"),
  };
};

describe("GitHub データの取得", () => {
  it("PR の判定材料を 1 回の GraphQL で取得する", async () => {
    const { graphql, github } = client();
    const empty = { totalCount: 0, nodes: [] };

    graphql.mockResolvedValue({
      repository: {
        databaseId: 1,
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          body: "",
          createdAt: "2026-01-01T00:00:00Z",
          headRefName: "branch",
          headRefOid: "head",
          baseRefName: "main",
          author: null,
          editor: null,
          lastEditedAt: null,
          headRepository: { databaseId: 1 },
          labels: empty,
          files: empty,
          latestOpinionatedReviews: empty,
          latestReviews: empty,
          commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: null } }] },
          potentialMergeCommit: null,
          baseRef: { target: { oid: "base", submodules: { nodes: [], pageInfo: { hasNextPage: false } } } },
          timelineItems: { pageCount: 0, pageInfo: { hasPreviousPage: false }, nodes: [] },
          recent: { pageCount: 0 },
        },
      },
    });

    const result = await github.pullRequest(7, Date.parse("2026-11-10T00:00:00Z"));

    expect(result.pr.headSha).toBe("head");
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, null, []],
    [
      { isBinary: false, isTruncated: false, text: "autopilot: {}" },
      null,
      [{ path: ".github/flightdeck.yml", text: "autopilot: {}" }],
    ],
    [
      null,
      { isBinary: false, isTruncated: false, text: "autopilot: {}" },
      [{ path: ".github/flightdeck.yaml", text: "autopilot: {}" }],
    ],
  ])("固定した base の設定を取得する", async (yml, yaml, expected) => {
    const { graphql, github } = client();

    graphql.mockResolvedValue({ repository: { yml, yaml } });

    expect(await github.configs("base")).toEqual(expected);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith(expect.any(String), {
      owner: "org",
      name: "repo",
      yml: "base:.github/flightdeck.yml",
      yaml: "base:.github/flightdeck.yaml",
    });
  });

  it("関連 PR と rules の不完全なページを拒否する", async () => {
    const { graphql, request, github } = client();

    graphql.mockResolvedValue({
      repository: {
        object: {
          associatedPullRequests: { totalCount: 0, nodes: [] },
          parents: { nodes: [{ associatedPullRequests: { totalCount: 2, nodes: [] } }] },
        },
      },
    });
    await expect(github.associated("a".repeat(40), 1)).rejects.toThrow("truncated");
    request.mockResolvedValue({
      data: [],
      response: new Response("[]", { headers: { link: '<https://api.github.com/page2>; rel="next"' } }),
    });
    await expect(github.rules("main")).rejects.toThrow("truncated");
  });

  it("rate limit でなければ既知の plan 制限だけを無視する", async () => {
    const { request, github } = client();
    const message = "upgrade to github pro make this repository public enable this feature";

    request.mockRejectedValueOnce(new ApiError(403, message));

    expect(await github.rules("main")).toEqual([]);

    request.mockRejectedValueOnce(new ApiError(403, message, true));
    await expect(github.rules("other")).rejects.toBeInstanceOf(ApiError);
    request.mockRejectedValueOnce(new ApiError(403, "permission denied"));
    await expect(github.rules("third")).rejects.toBeInstanceOf(ApiError);
  });

  it("REST で新しい SHA から古い SHA の向きに比較する", async () => {
    const { graphql, request, github } = client();

    graphql.mockResolvedValue({ repository: { defaultBranchRef: { compare: { status: "BEHIND" } } } });
    request.mockResolvedValue({ data: { status: "behind" }, response: new Response("{}") });

    expect(await github.compare("org/source", "new", "old")).toEqual({ source: "BEHIND", ancestry: "behind" });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/repos/org/source/compare/new...old");
  });
});

describe("rules の取得", () => {
  it("1 回の実行中は branch の rules を再利用する", async () => {
    const { request, github } = client();

    request.mockResolvedValue({ data: [], response: new Response("[]") });
    await github.rules("main");
    await github.rules("main");

    expect(request).toHaveBeenCalledTimes(1);

    await github.rules("other");

    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("repository の範囲", () => {
  it("同一 repository で SHA が一致する open PR だけ返す", async () => {
    const { graphql, github } = client();
    const pr = (
      number: number,
      repositoryId: number,
      state: string,
      headRefOid: string,
      mergeOid: string | null = null
    ) => ({
      number,
      state,
      headRefOid,
      potentialMergeCommit: mergeOid ? { oid: mergeOid } : null,
      repository: { databaseId: repositoryId },
    });

    graphql.mockResolvedValue({
      repository: {
        object: {
          associatedPullRequests: {
            totalCount: 5,
            nodes: [
              pr(1, 9, "OPEN", "sha"),
              pr(2, 1, "CLOSED", "sha"),
              pr(3, 1, "OPEN", "other"),
              pr(4, 1, "OPEN", "sha"),
              pr(5, 1, "OPEN", "other", "sha"),
            ],
          },
          parents: { nodes: [] },
        },
      },
    });

    expect(await github.associated("sha", 1)).toEqual([4, 5]);
  });

  it("potentialMergeCommit の SHA から親の head に関連する PR を特定する", async () => {
    const { graphql, github } = client();
    const pr = (number: number, mergeOid: string) => ({
      number,
      state: "OPEN",
      headRefOid: "head",
      potentialMergeCommit: { oid: mergeOid },
      repository: { databaseId: 1 },
    });

    graphql.mockResolvedValue({
      repository: {
        object: {
          associatedPullRequests: { totalCount: 0, nodes: [] },
          parents: {
            nodes: [
              { associatedPullRequests: { totalCount: 0, nodes: [] } },
              { associatedPullRequests: { totalCount: 2, nodes: [pr(6, "merge"), pr(7, "other")] } },
            ],
          },
        },
      },
    });

    expect(await github.associated("merge", 1)).toEqual([6]);
  });
});

describe("必須チェックと tree", () => {
  it("必須 context と integration_id を正規化する", async () => {
    const { request, github } = client();

    request.mockResolvedValue({
      data: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "ci", integration_id: 42 },
              { context: "external", integration_id: null },
            ],
          },
        },
      ],
      response: new Response("[]"),
    });

    const checks = await github.rules("main");

    expect(checks).toEqual([
      { context: "ci", integrationId: 42 },
      { context: "external", integrationId: null },
    ]);
  });

  it("親 tree の取得失敗と entry の不在を区別する", async () => {
    const { graphql, github } = client();

    graphql.mockResolvedValueOnce({ repository: { base: null, head: { entries: [] } } });
    await expect(github.trees("base", "head", "dir/sub")).rejects.toThrow("parent tree unavailable");
    graphql.mockResolvedValueOnce({
      repository: { base: { entries: [] }, head: { entries: [{ name: "sub", type: "commit", oid: "new" }] } },
    });

    expect(await github.trees("base", "head", "dir/sub")).toEqual({
      base: null,
      head: { name: "sub", type: "commit", oid: "new" },
    });
  });
});
