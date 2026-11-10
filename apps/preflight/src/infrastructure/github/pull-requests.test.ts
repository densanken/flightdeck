import { describe, expect, it, vi } from "vitest";

import { getCurrentPolicyState, listOpenPullRequestsForHeadShas } from "./pull-requests.js";
import { RecordingLogger } from "../../test-helper/platform.js";

import type { Logger } from "../../util/logger.js";

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), { status, headers });

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const requestBody = (init: RequestInit | undefined): Record<string, unknown> => {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
};

const currentInput = (fetchImpl: typeof fetch) => ({
  owner: "owner name",
  repo: "repo/name",
  pullRequestNumber: 7,
  installationToken: "token",
  fetchImpl,
  signal: new AbortController().signal,
});

const listInput = (logger: Logger = new RecordingLogger()) => ({
  owner: "owner",
  repo: "repo",
  headShas: ["shared-sha"],
  installationToken: "token",
  signal: new AbortController().signal,
  logger,
  deliveryId: "delivery-1",
});

const node = (number: number, title: string, headRefOid = "shared-sha", isDraft = false) => ({
  number,
  title,
  state: "OPEN",
  isDraft,
  headRefOid,
});

const graphQlPage = (input: {
  nodes: unknown[];
  totalCount: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
}) => ({
  data: {
    repository: {
      pullRequests: {
        totalCount: input.totalCount,
        nodes: input.nodes,
        pageInfo: {
          hasNextPage: input.hasNextPage ?? false,
          endCursor: input.endCursor ?? null,
        },
      },
    },
  },
});

describe("getCurrentPolicyState", () => {
  const response = (status: string, nodes: unknown[] = [], overrides: Record<string, unknown> = {}) => ({
    data: {
      repository: {
        pullRequest: { title: "feat: current", state: "MERGED", isDraft: false, headRefOid: "shared-sha" },
        object: { associatedPullRequests: { totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false } } },
        defaultBranchRef: { compare: { status, headTarget: { oid: "shared-sha" } } },
      },
    },
    ...overrides,
  });
  const read = (body: unknown, headSha = "shared-sha") => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    return getCurrentPolicyState({ ...currentInput(fetchImpl), headSha });
  };
  it.each(["AHEAD", "DIVERGED"])("%s と完全な空一覧なら走査しない", async (status) => {
    await expect(read(response(status))).resolves.toEqual({
      current: { title: "feat: current", state: "closed", draft: false, headSha: "shared-sha" },
      associatedPullRequests: [],
    });
  });
  it.each(["IDENTICAL", "BEHIND", "UNKNOWN"])("%s の空一覧は走査する", async (status) => {
    await expect(read(response(status))).resolves.toMatchObject({
      associatedPullRequests: undefined,
    });
  });
  it("open かつ同じ head の PR だけを採用する", async () => {
    await expect(
      read(
        response("AHEAD", [
          node(8, "fix: shared"),
          node(9, "other", "other"),
          { ...node(10, "closed"), state: "CLOSED" },
        ])
      )
    ).resolves.toMatchObject({
      associatedPullRequests: [{ number: 8, title: "fix: shared", headSha: "shared-sha", draft: false }],
    });
  });
  it("errors、SHA 不一致、打ち切りは一覧を破棄する", async () => {
    const truncated = response("AHEAD");
    truncated.data.repository.object.associatedPullRequests.pageInfo.hasNextPage = true;
    for (const result of [
      await read(response("AHEAD", [], { errors: [{ message: "partial" }] })),
      await read(response("AHEAD"), "old-sha"),
      await read(truncated),
    ]) {
      expect(result).toMatchObject({ associatedPullRequests: undefined });
    }
  });
  it("現在 head と異なる SHA でも比較と関連一覧が確定すれば再利用する", async () => {
    const body = response("AHEAD", [node(8, "fix: old", "old-sha")]);
    body.data.repository.defaultBranchRef.compare.headTarget.oid = "old-sha";
    await expect(read(body, "old-sha")).resolves.toMatchObject({
      associatedPullRequests: [{ number: 8, title: "fix: old", headSha: "old-sha", draft: false }],
    });
  });

  it("関連 PR の番号が重複する場合は一覧を破棄する", async () => {
    await expect(read(response("AHEAD", [node(8, "one"), node(8, "two")]))).resolves.toMatchObject({
      associatedPullRequests: undefined,
    });
  });

  it("PR 本体がない応答は失敗する", async () => {
    await expect(
      read({ errors: [{ message: "failed" }], data: { repository: { pullRequest: null } } })
    ).rejects.toMatchObject({ code: "GITHUB_API_FAILED" });
  });
});

describe("listOpenPullRequestsForHeadSha", () => {
  // 1 ページ 100 件で totalCount に応じた page 数を生成する
  // 600 件はちょうど 6 ページ（page 数上限）で完了する境界値
  const openPullRequestPageFetch =
    (totalCount: number): typeof fetch =>
    (request, init) => {
      const url = requestUrl(request);
      if (!url.endsWith("/graphql")) return Promise.resolve(jsonResponse([]));
      const cursor = (requestBody(init).variables as { cursor: string | null }).cursor;
      const page = cursor === null ? 1 : Number(cursor.replace("cursor-", "")) + 1;
      const offset = (page - 1) * 100;
      const count = Math.min(100, totalCount - offset);
      return Promise.resolve(
        jsonResponse(
          graphQlPage({
            nodes: Array.from({ length: count }, (_, index) =>
              node(offset + index + 1, `feat: title ${String(offset + index + 1)}`, "other-sha")
            ),
            totalCount,
            hasNextPage: offset + count < totalCount,
            endCursor: offset + count < totalCount ? `cursor-${String(page)}` : null,
          })
        )
      );
    };

  it.each([100, 101, 600])(
    "default-branch仕様で associated open PR が無い場合、%i件の全 open PR fallback を page 数上限内で走査する",
    async (totalCount) => {
      const fetchImpl = vi.fn<typeof fetch>(openPullRequestPageFetch(totalCount));

      await expect(listOpenPullRequestsForHeadShas({ ...listInput(), fetchImpl })).resolves.toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(Math.ceil(totalCount / 100));
    }
  );

  it("複数 SHA を 6 ページの一回の走査で照合する", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_request, init) => {
      const cursor = (requestBody(init).variables as { cursor: string | null }).cursor;
      const page = cursor === null ? 1 : Number(cursor) + 1;
      return Promise.resolve(
        jsonResponse(
          graphQlPage({
            nodes: page === 1 ? [node(1, "feat: first", "sha-1")] : page === 6 ? [node(2, "fix: second", "sha-2")] : [],
            totalCount: 2,
            hasNextPage: page < 6,
            endCursor: page < 6 ? String(page) : null,
          })
        )
      );
    });
    await expect(
      listOpenPullRequestsForHeadShas({ ...listInput(), headShas: ["sha-1", "sha-2"], fetchImpl })
    ).resolves.toEqual([
      { number: 1, title: "feat: first", headSha: "sha-1", draft: false },
      { number: 2, title: "fix: second", headSha: "sha-2", draft: false },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("全 open PR fallback は 7 ページ目が必要になった時点で取得未完了として拒否する", async () => {
    // 601 件は 7 ページ目が必要になり、page 数上限（6）を超える
    const fetchImpl = vi.fn<typeof fetch>(openPullRequestPageFetch(601));

    await expect(listOpenPullRequestsForHeadShas({ ...listInput(), fetchImpl })).rejects.toThrow("page limit");
    // GraphQL page 上限の 6 回まで叩いてから打ち切る
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("fallback でも shared head の全 PR を保持する", async () => {
    const fetchImpl = vi.fn<typeof fetch>((request) => {
      const url = requestUrl(request);
      return Promise.resolve(
        url.endsWith("/graphql")
          ? jsonResponse(
              graphQlPage({
                nodes: [node(20, "feat: first"), node(21, "fix: second"), node(22, "feat: other", "other-sha")],
                totalCount: 3,
              })
            )
          : jsonResponse([])
      );
    });

    await expect(listOpenPullRequestsForHeadShas({ ...listInput(), fetchImpl })).resolves.toEqual([
      { number: 20, title: "feat: first", headSha: "shared-sha", draft: false },
      { number: 21, title: "fix: second", headSha: "shared-sha", draft: false },
    ]);
  });

  it("GraphQL cursor の循環を fail-closed で拒否する", async () => {
    const graphCycle = vi.fn<typeof fetch>((request) =>
      Promise.resolve(
        requestUrl(request).endsWith("/graphql")
          ? jsonResponse(graphQlPage({ nodes: [], totalCount: 1, hasNextPage: true, endCursor: "same" }))
          : jsonResponse([])
      )
    );
    await expect(listOpenPullRequestsForHeadShas({ ...listInput(), fetchImpl: graphCycle })).rejects.toThrow("cursor");
  });

  it("pagination 中の件数変化は警告し、取得未完了として拒否する", async () => {
    const logger = new RecordingLogger();
    const countChanged = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          graphQlPage({ nodes: [node(1, "feat: first")], totalCount: 2, hasNextPage: true, endCursor: "next" })
        )
      )
      .mockResolvedValueOnce(jsonResponse(graphQlPage({ nodes: [node(2, "feat: second")], totalCount: 1 })));

    await expect(listOpenPullRequestsForHeadShas({ ...listInput(logger), fetchImpl: countChanged })).rejects.toThrow(
      "count changed"
    );
    expect(logger.records).toContainEqual({
      level: "warn",
      record: {
        event: "github_webhook_consume",
        feature: "title-validation",
        result: "open_pull_request_total_count_mismatch",
        deliveryId: "delivery-1",
        repository: "owner/repo",
        headSha: "shared-sha",
        expectedTotalCount: 2,
        observedTotalCount: 1,
      },
    });
  });

  it("pagination 中の重複、shape 不正を fail-closed で拒否する", async () => {
    const duplicate = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          graphQlPage({ nodes: [node(1, "feat: first")], totalCount: 2, hasNextPage: true, endCursor: "next" })
        )
      )
      .mockResolvedValueOnce(jsonResponse(graphQlPage({ nodes: [node(1, "feat: duplicate")], totalCount: 2 })));
    await expect(listOpenPullRequestsForHeadShas({ ...listInput(), fetchImpl: duplicate })).rejects.toThrow(
      "Duplicate"
    );

    const invalidShape = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([{ number: 1 }]));
    await expect(listOpenPullRequestsForHeadShas({ ...listInput(), fetchImpl: invalidShape })).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });
});
