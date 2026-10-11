import { describe, expect, it, vi } from "vitest";

import { SyncUsecaseImpl } from "./impl.js";

import type { CachedPullRequestList } from "../../domain/pull-request.js";
import type { RegisteredRepository } from "../../domain/repository.js";

const repo: RegisteredRepository = {
  repoId: "1",
  owner: "org",
  name: "repo",
  fullName: "org/repo",
  htmlUrl: "https://github.com/org/repo",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const cachedList: CachedPullRequestList = {
  repoId: "1",
  items: [],
  fetchedAt: "2026-07-11T00:00:00Z",
};

const createDeps = () => ({
  tokenProvider: { getToken: vi.fn().mockResolvedValue("token") },
  cooldownCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  pullRequestUsecase: {
    getCachedPullRequestList: vi.fn(),
    listOpenPullRequests: vi.fn(),
    warmPullRequestListCache: vi.fn().mockResolvedValue(cachedList),
  },
});

describe("SyncUsecaseImpl", () => {
  it("cooldown 中は sync_cooldown を投げ、warming を実行しない", async () => {
    const deps = createDeps();
    deps.cooldownCache.get.mockResolvedValue({
      repoId: "1",
      requestedAt: "2026-07-11T00:00:00Z",
      requestedByDiscordUserId: "user",
    });
    const usecase = new SyncUsecaseImpl(deps.tokenProvider, deps.cooldownCache, deps.pullRequestUsecase);

    await expect(usecase.sync(repo, "user")).rejects.toMatchObject({ type: "sync_cooldown" });
    expect(deps.pullRequestUsecase.warmPullRequestListCache).not.toHaveBeenCalled();
  });

  it("warming に成功したら一覧を返し cooldown を維持する", async () => {
    const deps = createDeps();
    const usecase = new SyncUsecaseImpl(deps.tokenProvider, deps.cooldownCache, deps.pullRequestUsecase);

    await expect(usecase.sync(repo, "user")).resolves.toEqual(cachedList);

    expect(deps.cooldownCache.set).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ repoId: "1", requestedByDiscordUserId: "user" })
    );
    expect(deps.pullRequestUsecase.warmPullRequestListCache).toHaveBeenCalledWith("token", "org", "repo", "1");
    expect(deps.cooldownCache.delete).not.toHaveBeenCalled();
  });

  it("warming に失敗したら cooldown を解除して rethrow する", async () => {
    const deps = createDeps();
    deps.pullRequestUsecase.warmPullRequestListCache.mockRejectedValue(new Error("github down"));
    const usecase = new SyncUsecaseImpl(deps.tokenProvider, deps.cooldownCache, deps.pullRequestUsecase);

    await expect(usecase.sync(repo, "user")).rejects.toThrow("github down");
    expect(deps.cooldownCache.delete).toHaveBeenCalledWith("1");
  });
});
