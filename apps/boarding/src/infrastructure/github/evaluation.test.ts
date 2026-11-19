import { describe, expect, it, vi } from "vitest";

import { GitHubGatewayImpl } from "./evaluation.js";
import { GitHubRequest } from "./request.js";

const pageInfo = { hasNextPage: false, endCursor: null };
const pr = {
  state: "OPEN",
  isDraft: false,
  body: "",
  lastEditedAt: null,
  headCommit: { nodes: [{ commit: { oid: "head", statusCheckRollup: null } }] },
  potentialMergeCommit: null,
  baseRefName: "main",
  baseRefOid: "stale-base",
  baseRef: {
    target: {
      oid: "base",
      file: { type: "tree", object: { __typename: "Tree", entries: [{ name: "alice", type: "tree" }] } },
    },
  },
  headRefOid: "head",
  isCrossRepository: false,
  headRepository: { databaseId: 1 },
  changedFiles: 1,
  author: { __typename: "User", databaseId: 1, login: "alice" },
  commits: {
    totalCount: 1,
    pageInfo,
    nodes: [
      {
        commit: {
          oid: "head",
          author: { user: { databaseId: 1, login: "alice" } },
          committer: { user: { databaseId: 1, login: "alice" } },
          signature: null,
        },
      },
    ],
  },
  reviews: { pageInfo, nodes: [] },
};
const json = (data: unknown) => Response.json({ data });
const compare = (files: unknown[], base = "base", head = "head") =>
  Response.json({
    permalink_url: `https://github.com/densanken/blog-contents/compare/densanken:${base}...densanken:${head}`,
    files,
  });

describe("GitHubGatewayImpl", () => {
  it("Merge 前の親コミットと head の差分を取得する", async () => {
    const value = {
      state: "MERGED",
      mergeCommit: {
        oid: "head",
        changedFilesIfAvailable: 2,
        parents: {
          nodes: [
            {
              oid: "base",
              file: { type: "tree", object: { __typename: "Tree", entries: [{ name: "old", type: "tree" }] } },
            },
          ],
        },
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: value } }))
      .mockResolvedValueOnce(
        compare([
          { filename: "authors/new/meta.yaml", status: "added" },
          { filename: "authors/old/meta.yaml", status: "removed" },
        ])
      );
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    expect(await gateway.mergedPullRequest(1)).toEqual({
      baseSha: "base",
      headSha: "head",
      baseRoots: ["old"],
      files: [
        { path: "authors/new/meta.yaml", removed: false, previousPath: undefined },
        { path: "authors/old/meta.yaml", removed: true, previousPath: undefined },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, "INVALID_RESPONSE"],
    [2, "INCOMPLETE_PAGINATION"],
  ])("Merge commit の変更件数が %s の場合は不完全な差分を拒否する", async (count, code) => {
    const value = {
      state: "MERGED",
      mergeCommit: { oid: "head", changedFilesIfAvailable: count, parents: { nodes: [{ oid: "base", file: null }] } },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: value } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/new/meta.yaml", status: "added" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.mergedPullRequest(1)).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(count === null ? 1 : 2);
  });

  it("head とマージコミットの Check と Status を合わせる", async () => {
    const check = {
      __typename: "CheckRun",
      name: "ci",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      checkSuite: { app: { databaseId: 2, slug: "github-actions" } },
    };
    const commit = (oid: string, nodes: unknown[]) => ({
      oid,
      statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } },
    });
    const value = {
      ...pr,
      headCommit: { nodes: [{ commit: commit("head", [check]) }] },
      potentialMergeCommit: commit("merge", [{ __typename: "StatusContext", context: "other", state: "SUCCESS" }]),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: value } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/post.md", status: "modified" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    const data = (await gateway.pullRequest(1)).mergeData;
    expect(data.ci).not.toBeNull();
    expect(data.ci?.checks[0]?.app?.slug).toBe("github-actions");
    expect(data.ci?.statuses).toEqual([{ context: "other", state: "success" }]);
  });

  it.each([
    ["head の情報が取得できない", { headCommit: null }],
    ["head が存在しない", { headCommit: { nodes: [] } }],
    ["head の SHA が一致しない", { headCommit: { nodes: [{ commit: { oid: "other", statusCheckRollup: null } }] } }],
    [
      "head の Check の件数が一致しない",
      {
        headCommit: {
          nodes: [{ commit: { oid: "head", statusCheckRollup: { contexts: { totalCount: 1, nodes: [] } } } }],
        },
      },
    ],
    [
      "マージコミットの Check の件数が一致しない",
      { potentialMergeCommit: { oid: "merge", statusCheckRollup: { contexts: { totalCount: 1, nodes: [] } } } },
    ],
  ])("%s場合は CI を不完全とする", async (_label, change) => {
    const value = { ...pr, ...change };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: value } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/post.md", status: "modified" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    expect((await gateway.pullRequest(1)).mergeData.ci).toBeNull();
  });

  it("PR、コミット、旧パスを含む差分と base のルートを取得する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: pr } }))
      .mockResolvedValueOnce(
        compare([{ filename: "authors/alice/new.md", previous_filename: "authors/alice/old.md", status: "renamed" }])
      );
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    const result = await gateway.pullRequest(2);
    expect(result.baseRoots).toEqual(["alice"]);
    expect(result.files).toEqual([
      { path: "authors/alice/new.md", removed: false, previousPath: "authors/alice/old.md" },
    ]);
    expect(result.commits[0]?.authorId).toBe(1);
  });

  it("PR に残る古い base ではなく main の現在の SHA を参照する", async () => {
    const fetcher = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ repository: { pullRequest: pr } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/post.md", status: "modified" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    expect((await gateway.pullRequest(2)).baseSha).toBe("base");
    expect((JSON.parse(fetcher.mock.calls[0]?.[1].body as string) as { query: string }).query).toContain(
      'file(path: "authors")'
    );
    expect(fetcher.mock.calls[1]?.[0]).toContain("/compare/base...head");
  });

  it("ページ送りでは base のツリーと CI を再取得しない", async () => {
    const first = { ...pr, commits: { ...pr.commits, totalCount: 2, pageInfo: { hasNextPage: true, endCursor: "c" } } };
    const second = {
      ...pr,
      headCommit: undefined,
      potentialMergeCommit: undefined,
      baseRef: { target: { oid: "base" } },
      commits: { ...pr.commits, totalCount: 2 },
    };
    const fetcher = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ repository: { pullRequest: first } }))
      .mockResolvedValueOnce(json({ repository: { pullRequest: second } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/post.md", status: "modified" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });

    const result = await gateway.pullRequest(2);
    expect(result.baseRoots).toEqual(["alice"]);
    expect(result.mergeData.ci).toEqual({ checks: [], statuses: [] });

    const firstVariables = (JSON.parse(fetcher.mock.calls[0]?.[1].body as string) as { variables: { first: boolean } })
      .variables;
    const secondVariables = (JSON.parse(fetcher.mock.calls[1]?.[1].body as string) as { variables: { first: boolean } })
      .variables;
    expect([firstVariables.first, secondVariables.first]).toEqual([true, false]);
    const query = (JSON.parse(fetcher.mock.calls[0]?.[1].body as string) as { query: string }).query;
    expect(query).not.toContain("userContentEdits");
    expect(query).toContain("headCommit: commits(last: 1) @include(if: $first)");
    expect(query).toContain("potentialMergeCommit @include(if: $first)");
  });

  it("main が更新されたら古い base の書き込みを拒否する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ repository: { pullRequest: { ...pr, baseRef: { target: { oid: "new-base" } } } } })
      );
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.verify(2, "base", "head")).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("Bot の PR 作成者を取得する", async () => {
    const bot = { __typename: "Bot", databaseId: 55, login: "renovate[bot]" };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: { ...pr, author: bot } } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/post.md", status: "modified" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    expect((await gateway.pullRequest(2)).author).toEqual({ id: 55, login: "renovate[bot]", isBot: true });
  });

  it("次ページがなくてもコミット総数と取得数が異なる場合は失敗する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ repository: { pullRequest: { ...pr, commits: { ...pr.commits, totalCount: 251 } } } })
      );
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.pullRequest(2)).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
  });

  it("変更されたルートだけ base と head の profile を取得する", async () => {
    const fetcher = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        json({ repository: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${String(index)}`, null])) })
      );
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await gateway.files("base", "head", ["alice", "bob"], ["alice"], ["bob"]);
    const query = (JSON.parse(fetcher.mock.calls[0]?.[1].body as string) as { query: string }).query;
    expect(query).toContain("base:authors/alice/profile.yaml");
    expect(query).toContain("head:authors/alice/profile.yml");
    expect(query).not.toContain("authors/bob/profile");
    expect(query).toContain("base:authors/bob/meta.yaml");
    expect(query).toContain("head:authors/bob/meta.yaml");
    expect(query).not.toContain("head:authors/alice/meta.yaml");
  });

  it("HEAD が H1 から H2 を経て H1 に戻っても H1 の SHA で差分を取得する", async () => {
    const live = { head: "head" };
    const fetcher = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ repository: { pullRequest: { ...pr, headRefOid: live.head } } }))
      .mockImplementationOnce((url) => {
        live.head = "other";
        const response = url.includes("/compare/base...head?")
          ? compare([{ filename: "authors/alice/h1.md", status: "added" }])
          : compare([{ filename: "scripts/h2.md", status: "added" }], "base", live.head);
        live.head = "head";
        return Promise.resolve(response);
      });
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    expect((await gateway.pullRequest(2)).files).toEqual([
      { path: "authors/alice/h1.md", removed: false, previousPath: undefined },
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toContain("/compare/base...head?per_page=1&page=1");
    expect(live.head).toBe("head");
  });

  it.each([
    ["other", "head"],
    ["base", "other"],
  ])("Compare の base %s または head %s が異なる場合は失敗する", async (base, head) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: pr } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/post.md", status: "modified" }], base, head));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.pullRequest(2)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([299, 300])("差分の完全性を確認できないファイル数 %s は失敗する", async (count) => {
    const files = Array.from({ length: count }, (_, index) => ({
      filename: `authors/alice/${String(index)}`,
      status: "modified",
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: { ...pr, changedFiles: 300 } } }))
      .mockResolvedValueOnce(compare(files));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.pullRequest(2)).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
  });

  it("base に authors がない場合はルートを空として取得する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ repository: { pullRequest: { ...pr, baseRef: { target: { oid: "base", file: null } } } } })
      )
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/meta.yaml", status: "added" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    expect((await gateway.pullRequest(2)).baseRoots).toEqual([]);
  });

  it("base の authors が Tree 以外なら失敗する", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      json({
        repository: {
          pullRequest: {
            ...pr,
            baseRef: { target: { oid: "base", file: { type: "blob", object: { __typename: "Blob" } } } },
          },
        },
      })
    );
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.pullRequest(2)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("App の Review を評価用データに保持する", async () => {
    const review = {
      state: "APPROVED",
      submittedAt: "2026-01-01T00:00:00Z",
      author: { __typename: "Bot", databaseId: 10, login: "boarding[bot]" },
      commit: { oid: "head" },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: { ...pr, reviews: { pageInfo, nodes: [review] } } } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/post.md", status: "modified" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    expect((await gateway.pullRequest(2)).reviews).toEqual([
      {
        reviewerId: 10,
        login: "boarding[bot]",
        isBot: true,
        state: "APPROVED",
        submittedAt: review.submittedAt,
        commitSha: "head",
      },
    ]);
  });

  it.each(["meta", "profile"])("大きすぎる %s を取得時に拒否する", async (name) => {
    const text = "あ".repeat(6000);
    const objects = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `f${String(index)}`,
        index === (name === "meta" ? 0 : 2) ? { __typename: "Blob", text, isBinary: false, isTruncated: false } : null,
      ])
    );
    const fetcher = vi.fn().mockResolvedValueOnce(json({ repository: objects }));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.files("base", "head", ["alice"], ["alice"], ["alice"])).rejects.toMatchObject({
      code: "YAML_SIZE_LIMIT",
    });
  });

  it("取得する YAML の合計が上限を超えたら拒否する", async () => {
    const blob = { __typename: "Blob", text: "a".repeat(9000), isBinary: false, isTruncated: false };
    const objects = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`f${String(index)}`, blob]));
    const fetcher = vi.fn().mockResolvedValueOnce(json({ repository: objects }));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.files("base", "head", ["alice"], ["alice"], ["alice"])).rejects.toMatchObject({
      code: "YAML_SIZE_LIMIT",
    });
  });

  it("切り詰められたファイルを拒否する", async () => {
    const objects = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `f${String(index)}`,
        index === 0 ? { __typename: "Blob", text: "editors: [alice]", isBinary: false, isTruncated: true } : null,
      ])
    );
    const fetcher = vi.fn().mockResolvedValueOnce(json({ repository: objects }));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.files("base", "head", ["alice"], [], [])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("旧パスを取得できない rename を失敗にする", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ repository: { pullRequest: pr } }))
      .mockResolvedValueOnce(compare([{ filename: "authors/alice/new.md", status: "renamed" }]));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.pullRequest(2)).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
  });

  it("コミットを全件取得できなければ失敗する", async () => {
    const incomplete = { ...pr, commits: { ...pr.commits, pageInfo: { hasNextPage: true, endCursor: null } } };
    const fetcher = vi.fn().mockResolvedValueOnce(json({ repository: { pullRequest: incomplete } }));
    const gateway = new GitHubGatewayImpl({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.pullRequest(2)).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
  });
});
