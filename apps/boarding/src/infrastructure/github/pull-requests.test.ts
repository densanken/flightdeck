import { describe, expect, it, vi } from "vitest";

import { GitHubOpenPullRequests } from "./pull-requests.js";
import { GitHubRequest } from "./request.js";

const page = (numbers: number[], hasNextPage: boolean, endCursor: string | null) =>
  Response.json({
    data: {
      repository: {
        pullRequests: { nodes: numbers.map((number) => ({ number })), pageInfo: { hasNextPage, endCursor } },
      },
    },
  });

describe("GitHubOpenPullRequests", () => {
  it("マージコミットの親に関連する同じリポジトリの PR を特定する", async () => {
    const item = {
      number: 4,
      state: "OPEN",
      baseRefName: "main",
      headRefOid: "head",
      potentialMergeCommit: { oid: "merge" },
      repository: { databaseId: 1 },
    };
    const connection = (nodes: unknown[]) => ({ totalCount: nodes.length, nodes });
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          repository: {
            object: {
              statusCheckRollup: null,
              associatedPullRequests: connection([item]),
              parents: {
                nodes: [
                  {
                    associatedPullRequests: connection([item, { ...item, number: 5, repository: { databaseId: 2 } }]),
                  },
                ],
              },
            },
          },
        },
      })
    );
    const gateway = new GitHubOpenPullRequests({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.associated("merge", 1)).resolves.toEqual({
      numbers: [4, 4],
      ci: { checks: [], statuses: [] },
    });
  });

  it("対象コミットの CI と関連 PR を 1 回の query で取得する", async () => {
    const check = {
      __typename: "CheckRun",
      name: "ci",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      checkSuite: { app: { databaseId: 2, slug: "github-actions" } },
    };
    const item = {
      number: 3,
      state: "OPEN",
      baseRefName: "main",
      headRefOid: "head",
      potentialMergeCommit: null,
      repository: { databaseId: 1 },
    };
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(
      Response.json({
        data: {
          repository: {
            object: {
              statusCheckRollup: { contexts: { totalCount: 1, nodes: [check] } },
              associatedPullRequests: { totalCount: 1, nodes: [item] },
              parents: { nodes: [] },
            },
          },
        },
      })
    );
    const gateway = new GitHubOpenPullRequests({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });

    await expect(gateway.associated("head", 1)).resolves.toEqual({
      numbers: [3],
      ci: {
        checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 2, slug: "github-actions" } }],
        statuses: [],
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const request = JSON.parse(fetcher.mock.calls[0]?.[1].body as string) as {
      query: string;
      variables: { oid: string };
    };
    expect(request.variables.oid).toBe("head");
    expect(request.query.match(/statusCheckRollup/g)).toHaveLength(1);
  });

  it.each([
    ["CI のページが不足", { contexts: { totalCount: 1, nodes: [] } }],
    ["CI の応答が不正", { contexts: { totalCount: 1, nodes: [null] } }],
  ])("%sでも PR を返し CI は不明とする", async (_name, statusCheckRollup) => {
    const item = {
      number: 3,
      state: "OPEN",
      baseRefName: "main",
      headRefOid: "head",
      potentialMergeCommit: null,
      repository: { databaseId: 1 },
    };
    const object = {
      statusCheckRollup,
      associatedPullRequests: { totalCount: 1, nodes: [item] },
      parents: { nodes: [] },
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { repository: { object } } }));
    const gateway = new GitHubOpenPullRequests({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });

    await expect(gateway.associated("head", 1)).resolves.toEqual({ numbers: [3], ci: null });
  });

  it.each([["associatedPullRequests"], ["statusCheckRollup"]])("%s の部分エラーは再試行する", async (field) => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        data: { repository: { object: null } },
        errors: [{ path: ["repository", "object", field] }],
      })
    );
    const gateway = new GitHubOpenPullRequests({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.associated("head", 1)).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("関連 PR が途中で切れていたら失敗する", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          repository: {
            object: {
              statusCheckRollup: null,
              associatedPullRequests: { totalCount: 1, nodes: [] },
              parents: { nodes: [] },
            },
          },
        },
      })
    );
    const gateway = new GitHubOpenPullRequests({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.associated("sha", 1)).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
  });

  it("全ページの open PR を取得する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], true, "next"))
      .mockResolvedValueOnce(page([2, 3], false, null));
    const gateway = new GitHubOpenPullRequests({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.list()).resolves.toEqual([1, 2, 3]);
  });

  it("カーソルが進まない場合は失敗する", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(page([1], true, "same")));
    const gateway = new GitHubOpenPullRequests({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.list()).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
  });
});
