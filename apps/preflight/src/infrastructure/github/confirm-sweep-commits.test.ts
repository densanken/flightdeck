import { describe, expect, it, vi } from "vitest";

import { confirmSweepCommits } from "./commit-status.js";

describe("confirmSweepCommits", () => {
  const connection = () => ({
    totalCount: 1,
    nodes: [
      {
        number: 1,
        title: "feat: a",
        state: "OPEN",
        isDraft: false,
        headRefOid: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
      },
    ],
    pageInfo: { hasNextPage: false },
  });
  const repository = () => ({
    o0: { oid: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8", associatedPullRequests: connection() },
    o1: {
      oid: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
      associatedPullRequests: { ...connection(), totalCount: 0, nodes: [] as ReturnType<typeof connection>["nodes"] },
    },
    defaultBranchRef: {
      c0: { status: "AHEAD", headTarget: { oid: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" } },
      c1: { status: "DIVERGED", headTarget: { oid: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" } },
    },
  });
  const confirm = (body: unknown) =>
    confirmSweepCommits({
      owner: "owner",
      repo: "repo",
      shas: ["86f7e437faa5a7fce15d1ddcb9eaeaea377667b8", "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"],
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
          headRefOid: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
        });
        repo.o0.associatedPullRequests.totalCount = 2;
      },
    ],
    [
      "比較先の SHA 不一致",
      (repo: ReturnType<typeof repository>) => {
        repo.defaultBranchRef.c0.headTarget.oid = "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98";
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
      ["86f7e437faa5a7fce15d1ddcb9eaeaea377667b8", undefined],
      ["e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98", []],
    ]);
  });

  it("alias ごとの SHA と関連 PR を対応付ける", async () => {
    const repo = repository();
    repo.o1.associatedPullRequests = {
      totalCount: 1,
      nodes: [
        {
          number: 2,
          title: "fix: b",
          state: "OPEN",
          isDraft: true,
          headRefOid: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
        },
      ],
      pageInfo: { hasNextPage: false },
    };
    expect([...(await confirm({ data: { repository: repo } }))]).toEqual([
      [
        "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
        [{ number: 1, title: "feat: a", draft: false, headSha: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" }],
      ],
      [
        "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
        [{ number: 2, title: "fix: b", draft: true, headSha: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" }],
      ],
    ]);
  });
});
