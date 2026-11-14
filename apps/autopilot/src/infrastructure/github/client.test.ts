import { ApiError } from "@flightdeck/github-policy";
import { describe, expect, it, vi } from "vitest";

import { GitHubGatewayImpl } from "./client.js";

import type { GitHubRequest } from "@flightdeck/github-policy";

describe("Merge API", () => {
  it("評価した SHA と squash を指定する", async () => {
    const request = vi.fn().mockResolvedValue({ data: { merged: true }, response: { status: 200 } });
    const github = new GitHubGatewayImpl({ request } as unknown as GitHubRequest, "org/repo");
    expect(await github.merge(3, "head")).toEqual({ merged: true, status: 200 });
    expect(request).toHaveBeenCalledWith("/repos/org/repo/pulls/3/merge", "PUT", {
      sha: "head",
      merge_method: "squash",
    });
  });

  it.each([403, 405, 409, 422])("GitHub の拒否 %i を記録可能な結果として返す", async (status) => {
    const request = vi.fn().mockRejectedValue(new ApiError(status));
    const github = new GitHubGatewayImpl({ request } as unknown as GitHubRequest, "org/repo");
    expect(await github.merge(3, "head")).toEqual({ merged: false, status });
  });

  it.each([
    ["認証失敗", new ApiError(401)],
    ["rate limit の 403", new ApiError(403, "rate limit", true)],
    ["rate limit の 429", new ApiError(429)],
    ["サーバーエラー", new ApiError(500)],
  ])("%s は API エラーとして伝える", async (_name, error) => {
    const request = vi.fn().mockRejectedValue(error);
    const github = new GitHubGatewayImpl({ request } as unknown as GitHubRequest, "org/repo");
    await expect(github.merge(3, "head")).rejects.toBe(error);
  });
});
