import { describe, expect, it, vi } from "vitest";

import { confirmSweepCommits } from "./commit-status.js";

describe("confirmSweepCommits", () => {
  const connection = () => ({
    totalCount: 1,
    nodes: [{ number: 1, title: "feat: a", state: "OPEN", isDraft: false, headRefOid: "a" }],
    pageInfo: { hasNextPage: false },
  });
  const repository = () => ({
    o0: { oid: "a", associatedPullRequests: connection() },
    o1: {
      oid: "b",
      associatedPullRequests: { ...connection(), totalCount: 0, nodes: [] as ReturnType<typeof connection>["nodes"] },
    },
    defaultBranchRef: {
      c0: { status: "AHEAD", headTarget: { oid: "a" } },
      c1: { status: "DIVERGED", headTarget: { oid: "b" } },
    },
  });
  const confirm = (body: unknown) =>
    confirmSweepCommits({
      owner: "owner",
      repo: "repo",
      shas: ["a", "b"],
      installationToken: "token",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
      signal: new AbortController().signal,
    });

  it("GraphQL errors があれば応答全体を拒否する", async () => {
    await expect(confirm({ data: { repository: repository() }, errors: [{ message: "failed" }] })).rejects.toThrow();
  });

  it.each([
    [
      "default branch 上の SHA",
      (repo: ReturnType<typeof repository>) => {
        repo.defaultBranchRef.c0.status = "IDENTICAL";
      },
    ],
    [
      "関連 PR 番号の重複",
      (repo: ReturnType<typeof repository>) => {
        repo.o0.associatedPullRequests.nodes.push({
          number: 1,
          title: "feat: title",
          state: "OPEN",
          isDraft: false,
          headRefOid: "a",
        });
        repo.o0.associatedPullRequests.totalCount = 2;
      },
    ],
    [
      "比較先の SHA 不一致",
      (repo: ReturnType<typeof repository>) => {
        repo.defaultBranchRef.c0.headTarget.oid = "b";
      },
    ],
    [
      "件数不一致",
      (repo: ReturnType<typeof repository>) => {
        repo.o0.associatedPullRequests.totalCount = 2;
      },
    ],
    [
      "次ページあり",
      (repo: ReturnType<typeof repository>) => {
        repo.o0.associatedPullRequests.pageInfo.hasNextPage = true;
      },
    ],
    [
      "関連一覧が null",
      (repo: ReturnType<typeof repository>) => {
        Object.assign(repo.o0, { associatedPullRequests: null });
      },
    ],
  ])("%s の alias だけを拒否する", async (_label, invalidate) => {
    const repo = repository();
    invalidate(repo);
    expect([...(await confirm({ data: { repository: repo } }))]).toEqual([
      ["a", undefined],
      ["b", []],
    ]);
  });

  it("alias ごとの SHA と関連 PR を対応付ける", async () => {
    const repo = repository();
    repo.o1.associatedPullRequests = {
      totalCount: 1,
      nodes: [{ number: 2, title: "fix: b", state: "OPEN", isDraft: true, headRefOid: "b" }],
      pageInfo: { hasNextPage: false },
    };
    expect([...(await confirm({ data: { repository: repo } }))]).toEqual([
      ["a", [{ number: 1, title: "feat: a", draft: false, headSha: "a" }]],
      ["b", [{ number: 2, title: "fix: b", draft: true, headSha: "b" }]],
    ]);
  });
});
