import { describe, expect, it, vi } from "vitest";

import { GitHubGatewayImpl } from "./client.js";

import type { GitHubRequest } from "@flightdeck/github-policy";

const client = () => {
  const graphql = vi.fn<(query: string, variables: Record<string, unknown>) => Promise<unknown>>();
  const request =
    vi.fn<(path: string, method?: string, body?: unknown) => Promise<{ data: unknown; response: Response }>>();
  return {
    graphql,
    request,
    github: new GitHubGatewayImpl({ graphql, request } as unknown as GitHubRequest, "org/repo"),
  };
};

describe("レビューのリクエスト", () => {
  it("評価した SHA に本文なしでレビューを投稿する", async () => {
    const { request, github } = client();

    request.mockResolvedValue({ data: { id: 9 }, response: new Response("{}") });

    expect(await github.approve(7, "verified-head")).toEqual({ status: 200, reviewId: 9 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/repos/org/repo/pulls/7/reviews", "POST", {
      event: "APPROVE",
      commit_id: "verified-head",
    });
  });

  it("レビューの状態を取得する", async () => {
    const { request, github } = client();

    request.mockResolvedValue({ data: { state: "DISMISSED" }, response: new Response("{}") });

    expect(await github.reviewState(7, 8)).toBe("DISMISSED");
    expect(request).toHaveBeenCalledWith("/repos/org/repo/pulls/7/reviews/8");
  });

  it("レビューの撤回を 1 回のリクエストで行う", async () => {
    const { request, github } = client();

    request.mockResolvedValue({ data: {}, response: new Response("{}") });

    await github.dismiss(7, 8, "draft");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/repos/org/repo/pulls/7/reviews/8/dismissals", "PUT", {
      message: "conditions no longer met (draft)",
    });
  });
});

describe("repository 内の探索", () => {
  it("検索をイベントの repository に限定する", async () => {
    const { graphql, github } = client();

    graphql.mockResolvedValue({ search: { nodes: [] } });
    await github.search("2026-01-01");

    expect(graphql).toHaveBeenCalledWith(expect.any(String), {
      query: 'repo:org/repo is:pr is:open draft:false created:<2026-01-01 -label:"autopilot:skip"',
    });
  });
});
