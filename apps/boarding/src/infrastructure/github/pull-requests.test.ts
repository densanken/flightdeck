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
