import { describe, expect, it, vi } from "vitest";

import { getCurrentPullRequestTitleState, listOpenPullRequestsForHeadSha } from "./pull-requests.js";
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
  headSha: "shared-sha",
  installationToken: "token",
  signal: new AbortController().signal,
  logger,
  deliveryId: "delivery-1",
});

const restPullRequest = (number: number, title: string, headSha = "shared-sha", state = "open", draft = false) => ({
  number,
  title,
  state,
  draft,
  head: { sha: headSha },
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

describe("getCurrentPullRequestTitleState", () => {
  it("現在の title, head SHA, state を返し、owner と repo を encode した URL へ送る", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ title: "feat: current title", state: "open", head: { sha: "abc123" }, draft: false })
      );

    await expect(getCurrentPullRequestTitleState(currentInput(fetchImpl))).resolves.toEqual({
      title: "feat: current title",
      headSha: "abc123",
      state: "open",
      draft: false,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/owner%20name/repo%2Fname/pulls/7");
  });

  it("shape が不正な成功 response を GITHUB_API_FAILED で reject する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ title: "missing head", state: "open" }));
    await expect(getCurrentPullRequestTitleState(currentInput(fetchImpl))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });

  it("JSON として不正な成功 body を invalid JSON として reject する", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>not json", { status: 200 }));
    const error = await getCurrentPullRequestTitleState(currentInput(fetchImpl)).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "GITHUB_API_FAILED" });
    expect(error instanceof Error ? error.message : "").toContain("invalid JSON");
  });
});

describe("listOpenPullRequestsForHeadSha", () => {
  it("commit-associated PR API を全 page 取得し、open かつ head SHA 完全一致だけを返す", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([restPullRequest(8, "feat: other", "other-sha"), restPullRequest(7, "feat: current")], 200, {
          Link: '<https://api.github.com/repos/owner/repo/commits/shared-sha/pulls?per_page=100&page=2>; rel="next"',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([restPullRequest(10, "fix: shared"), restPullRequest(11, "fix: closed", "shared-sha", "closed")])
      );

    await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl })).resolves.toEqual([
      { number: 7, title: "feat: current", headSha: "shared-sha", draft: false },
      { number: 10, title: "fix: shared", headSha: "shared-sha", draft: false },
    ]);
    expect(fetchImpl.mock.calls.map(([request]) => requestUrl(request))).toEqual([
      "https://api.github.com/repos/owner/repo/commits/shared-sha/pulls?per_page=100&page=1",
      "https://api.github.com/repos/owner/repo/commits/shared-sha/pulls?per_page=100&page=2",
    ]);
  });

  // 1 ページ 100 件で totalCount に応じた page 数を生成する
  // 5,000 件はちょうど 50 ページ（page 数上限）で完了する境界値
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

  it.each([1_000, 1_001, 5_000])(
    "default-branch仕様で associated open PR が無い場合、%i件の全 open PR fallback を page 数上限内で走査する",
    async (totalCount) => {
      const fetchImpl = vi.fn<typeof fetch>(openPullRequestPageFetch(totalCount));

      await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl })).resolves.toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(1 + Math.ceil(totalCount / 100));
    }
  );

  it("全 open PR fallback は 51 ページ目が必要になった時点で取得未完了として拒否する", async () => {
    // 5,001 件は 51 ページ目が必要になり、page 数上限（50）を超える
    const fetchImpl = vi.fn<typeof fetch>(openPullRequestPageFetch(5_001));

    await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl })).rejects.toThrow("page limit");
    // REST の commit-associated 確認 1 回 + GraphQL page 上限の 50 回まで叩いてから打ち切る
    expect(fetchImpl).toHaveBeenCalledTimes(1 + 50);
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
          : jsonResponse([restPullRequest(99, "fix: merged", "shared-sha", "closed")])
      );
    });

    await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl })).resolves.toEqual([
      { number: 20, title: "feat: first", headSha: "shared-sha", draft: false },
      { number: 21, title: "fix: second", headSha: "shared-sha", draft: false },
    ]);
  });

  it("REST page と GraphQL cursor の循環を fail-closed で拒否する", async () => {
    const restCycle = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([], 200, {
        Link: '<https://api.github.com/repos/owner/repo/commits/shared-sha/pulls?per_page=100&page=1>; rel="next"',
      })
    );
    await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl: restCycle })).rejects.toThrow("cycle");

    const graphCycle = vi.fn<typeof fetch>((request) =>
      Promise.resolve(
        requestUrl(request).endsWith("/graphql")
          ? jsonResponse(graphQlPage({ nodes: [], totalCount: 1, hasNextPage: true, endCursor: "same" }))
          : jsonResponse([])
      )
    );
    await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl: graphCycle })).rejects.toThrow("cursor");
  });

  it("pagination 中の件数変化を構造化 Logger の警告として扱い、取得できた head SHA 一致 PR で成功にする", async () => {
    const logger = new RecordingLogger();
    const countChanged = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse(
          graphQlPage({ nodes: [node(1, "feat: first")], totalCount: 2, hasNextPage: true, endCursor: "next" })
        )
      )
      .mockResolvedValueOnce(jsonResponse(graphQlPage({ nodes: [node(2, "feat: second")], totalCount: 1 })));

    await expect(listOpenPullRequestsForHeadSha({ ...listInput(logger), fetchImpl: countChanged })).resolves.toEqual([
      { number: 1, title: "feat: first", headSha: "shared-sha", draft: false },
      { number: 2, title: "feat: second", headSha: "shared-sha", draft: false },
    ]);
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
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse(
          graphQlPage({ nodes: [node(1, "feat: first")], totalCount: 2, hasNextPage: true, endCursor: "next" })
        )
      )
      .mockResolvedValueOnce(jsonResponse(graphQlPage({ nodes: [node(1, "feat: duplicate")], totalCount: 2 })));
    await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl: duplicate })).rejects.toThrow("Duplicate");

    const invalidShape = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([{ number: 1 }]));
    await expect(listOpenPullRequestsForHeadSha({ ...listInput(), fetchImpl: invalidShape })).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });
});
