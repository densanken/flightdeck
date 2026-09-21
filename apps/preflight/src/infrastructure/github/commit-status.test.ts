import { describe, expect, it, vi } from "vitest";

import {
  listPullRequestCommitTitleStatuses,
  PR_TITLE_STATUS_CONTEXT,
  setPullRequestTitleStatus,
} from "./commit-status.js";

const commitNode = (
  oid: string,
  overrides: {
    state?: unknown;
    openHeads?: string[];
    closedHeads?: string[];
    totalCount?: number;
  } = {}
) => {
  const nodes = [
    ...(overrides.openHeads ?? []).map((headRefOid) => ({ state: "OPEN", headRefOid })),
    ...(overrides.closedHeads ?? []).map((headRefOid) => ({ state: "CLOSED", headRefOid })),
  ];
  return {
    commit: {
      oid,
      status:
        overrides.state === undefined || overrides.state === null ? null : { context: { state: overrides.state } },
      associatedPullRequests: { totalCount: overrides.totalCount ?? nodes.length, nodes },
    },
  };
};

const commitsResponse = (
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null }
) => Response.json({ data: { repository: { pullRequest: { commits: { nodes, pageInfo } } } } });

const sweepInput = (fetchImpl: typeof fetch) => ({
  owner: "owner",
  repo: "repo",
  pullRequestNumber: 7,
  installationToken: "token",
  fetchImpl,
  signal: new AbortController().signal,
});

const input = (fetchImpl: typeof fetch, overrides: { description?: string } = {}) => ({
  owner: "owner name",
  repo: "repo/name",
  sha: "abc/123",
  state: "pending" as const,
  description: overrides.description ?? "タイトルを検証しています",
  targetUrl: "https://www.conventionalcommits.org/ja/v1.0.0/",
  installationToken: "token",
  fetchImpl,
  signal: new AbortController().signal,
});

describe("setPullRequestTitleStatus", () => {
  it("path segment を escape して commit status を投稿する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 201 }));

    await setPullRequestTitleStatus(input(fetchImpl));

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/repos/owner%20name/repo%2Fname/statuses/abc%2F123");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      state: "pending",
      description: "タイトルを検証しています",
      context: PR_TITLE_STATUS_CONTEXT,
      target_url: "https://www.conventionalcommits.org/ja/v1.0.0/",
    });
  });

  it("description を UTF-8 の上限内へ切り詰めて投稿する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 201 }));

    await setPullRequestTitleStatus(input(fetchImpl, { description: "あ".repeat(47) }));

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as { description: string };
    expect(body.description).toBe("あ".repeat(46));
    expect(new TextEncoder().encode(body.description).length).toBeLessThanOrEqual(140);
  });

  it("target URL が未指定なら request body から省略する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 201 }));

    await setPullRequestTitleStatus({ ...input(fetchImpl), targetUrl: undefined });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).not.toHaveProperty("target_url");
  });

  it("想定外の status code を fail-closed で拒否し、retry 対象外として 1 回で打ち切る", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 422 }));

    await expect(setPullRequestTitleStatus(input(fetchImpl))).rejects.toMatchObject({ code: "GITHUB_API_FAILED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("一時的な 5xx の後で retry し、同じ context へ同じ body を再送してから成功する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));

    await setPullRequestTitleStatus(input(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0] ?? [];
    const [secondUrl, secondInit] = fetchImpl.mock.calls[1] ?? [];
    expect(secondUrl).toBe(firstUrl);
    expect(JSON.parse(secondInit?.body as string)).toEqual(JSON.parse(firstInit?.body as string));
  });

  it("一時的な network error の後で retry し、同じ context へ同じ body を再送してから成功する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));

    await setPullRequestTitleStatus(input(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0] ?? [];
    const [secondUrl, secondInit] = fetchImpl.mock.calls[1] ?? [];
    expect(secondUrl).toBe(firstUrl);
    expect(JSON.parse(secondInit?.body as string)).toEqual(JSON.parse(firstInit?.body as string));
  });

  it("再試行しても 5xx が続けば、request.ts の既定 max attempts を使い切って GITHUB_API_FAILED で失敗する", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 503 }));

      const result = setPullRequestTitleStatus(input(fetchImpl));
      // advanceTimersByTimeAsync の完了より先に reject し得るため、実際の検証（下の expect(result).rejects）より前に unhandled rejection として検出されないよう先に catch を付けておく
      result.catch(() => undefined);
      // 5xx の exponential backoff（既定は数百 ms オーダー）による内部の sleep（setTimeout）をすべて進める
      // request.ts の既定 retry budget（2000ms）自体を使い切らせる意図ではなく、それより十分大きい値で
      // maxAttempts 到達による打ち切りまで進めるための余裕
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(result).rejects.toMatchObject({ code: "GITHUB_API_FAILED" });
      // request.ts の DEFAULT_RETRY_ATTEMPTS（現状 3）と一致させる
      // 既定値を変えたらここも合わせて更新する
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listPullRequestCommitTitleStatuses", () => {
  it("GraphQL の全 status state を domain の分類へ正規化し、status が無ければ null を返す", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      commitsResponse([
        commitNode("stale-error", { state: "ERROR" }),
        commitNode("stale-expected", { state: "EXPECTED" }),
        commitNode("stale-failure", { state: "FAILURE" }),
        commitNode("stale-pending", { state: "PENDING" }),
        commitNode("already-success", { state: "SUCCESS" }),
        commitNode("never-validated"),
        {
          commit: {
            oid: "context-not-found",
            status: { context: null },
            associatedPullRequests: { totalCount: 0, nodes: [] },
          },
        },
      ])
    );

    await expect(listPullRequestCommitTitleStatuses(sweepInput(fetchImpl))).resolves.toEqual([
      {
        sha: "stale-error",
        statusState: "not_success",
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      {
        sha: "stale-expected",
        statusState: "not_success",
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      {
        sha: "stale-failure",
        statusState: "not_success",
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      {
        sha: "stale-pending",
        statusState: "not_success",
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      {
        sha: "already-success",
        statusState: "success",
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      {
        sha: "never-validated",
        statusState: null,
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      {
        sha: "context-not-found",
        statusState: null,
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
    ]);
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as { variables: Record<string, unknown> };
    expect(body.variables).toEqual({
      owner: "owner",
      repo: "repo",
      number: 7,
      context: PR_TITLE_STATUS_CONTEXT,
      cursor: null,
    });
  });

  it.each([
    ["未知の値", "QUEUED"],
    ["文字列以外", 1],
  ])("GraphQL status state が%sなら fail-closed で拒否する", async (_caseName, state) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(commitsResponse([commitNode("invalid-state", { state })]));

    await expect(listPullRequestCommitTitleStatuses(sweepInput(fetchImpl))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });

  it.each([
    [
      "status field が欠落している",
      {
        commit: {
          oid: "missing-status",
          associatedPullRequests: { totalCount: 0, nodes: [] },
        },
      },
    ],
    [
      "context field が欠落している",
      {
        commit: {
          oid: "missing-context",
          status: {},
          associatedPullRequests: { totalCount: 0, nodes: [] },
        },
      },
    ],
  ])("GraphQL response の%s場合は status 無しと解釈せず拒否する", async (_caseName, node) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(commitsResponse([node]));

    await expect(listPullRequestCommitTitleStatuses(sweepInput(fetchImpl))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });

  it("open PR の head かどうかを state で判定し、件数が切れたら truncated にする", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        commitsResponse([
          commitNode("stacked-head", { state: "FAILURE", openHeads: ["stacked-head"] }),
          commitNode("contained-only", { state: "FAILURE", openHeads: ["other-sha"] }),
          commitNode("closed-head", { state: "FAILURE", closedHeads: ["closed-head"] }),
          commitNode("too-many-prs", { state: "FAILURE", openHeads: ["other-sha"], totalCount: 99 }),
        ])
      );

    const commits = await listPullRequestCommitTitleStatuses(sweepInput(fetchImpl));

    expect(commits.map((commit) => [commit.sha, commit.isOpenPullRequestHead])).toEqual([
      ["stacked-head", true],
      ["contained-only", false],
      // closed PR の head は掃除してよい
      ["closed-head", false],
      ["too-many-prs", false],
    ]);
    expect(commits.map((commit) => commit.associatedPullRequestsTruncated)).toEqual([false, false, false, true]);
  });

  it("cursor を辿って全 page を走査し、循環では失敗する", async () => {
    const paged = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        commitsResponse([commitNode("page-1", { state: "FAILURE" })], { hasNextPage: true, endCursor: "cursor-1" })
      )
      .mockResolvedValueOnce(commitsResponse([commitNode("page-2", { state: "FAILURE" })]));

    await expect(listPullRequestCommitTitleStatuses(sweepInput(paged))).resolves.toMatchObject([
      { sha: "page-1" },
      { sha: "page-2" },
    ]);

    const looping = vi
      .fn<typeof fetch>()
      .mockResolvedValue(commitsResponse([], { hasNextPage: true, endCursor: "same-cursor" }));

    await expect(listPullRequestCommitTitleStatuses(sweepInput(looping))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });

  it("想定外の shape と partial error を fail-closed で拒否する", async () => {
    const invalidShape = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { repository: null } }));
    await expect(listPullRequestCommitTitleStatuses(sweepInput(invalidShape))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });

    // GraphQL は partial error でも HTTP 200 を返す
    // data が揃って見えても信用しない
    const partialError = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [commitNode("c1", { state: "FAILURE" })],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      })
    );
    await expect(listPullRequestCommitTitleStatuses(sweepInput(partialError))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });

  it("GitHub の実 response を解釈できる", async () => {
    const head = "f9cbe703248efa25c564788935c6bdffae621605";
    const associated = { totalCount: 1, nodes: [{ state: "OPEN", headRefOid: head }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: "43ef307146b744dc9fb967fbcfc634dbed8aa018",
                      status: null,
                      associatedPullRequests: associated,
                    },
                  },
                  {
                    commit: {
                      oid: "56c92e51ab446e4df04b77c20a5047ffdb4ee3d5",
                      status: { context: { state: "SUCCESS" } },
                      associatedPullRequests: associated,
                    },
                  },
                  {
                    commit: {
                      oid: head,
                      status: { context: { state: "SUCCESS" } },
                      associatedPullRequests: associated,
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: "Mw" },
              },
            },
          },
        },
      })
    );

    await expect(listPullRequestCommitTitleStatuses(sweepInput(fetchImpl))).resolves.toEqual([
      {
        sha: "43ef307146b744dc9fb967fbcfc634dbed8aa018",
        statusState: null,
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      {
        sha: "56c92e51ab446e4df04b77c20a5047ffdb4ee3d5",
        statusState: "success",
        isOpenPullRequestHead: false,
        associatedPullRequestsTruncated: false,
      },
      { sha: head, statusState: "success", isOpenPullRequestHead: true, associatedPullRequestsTruncated: false },
    ]);
  });
});
