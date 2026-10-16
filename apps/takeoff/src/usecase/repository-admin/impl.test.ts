import { describe, expect, it, vi } from "vitest";

import { RepositoryAdminUsecaseImpl } from "./impl.js";
import { AppError } from "../../domain/errors.js";
import { MockRegisteredRepositoryStore } from "../../repository/kv/impl.mock.js";

import type { RepositoryIndex } from "../../domain/repository.js";
import type { GitHubRepository } from "../github.js";

const gitHubRepository: GitHubRepository = {
  id: 123,
  name: "repo",
  full_name: "org/repo",
  html_url: "https://github.com/org/repo",
  owner: { login: "org" },
};

const createDeps = () => ({
  githubClient: {
    getRepository: vi.fn().mockResolvedValue(gitHubRepository),
    getRepositoryById: vi.fn().mockResolvedValue(gitHubRepository),
    listInstallationRepositories: vi.fn(),
    listOpenPullRequests: vi.fn(),
    getPullRequest: vi.fn(),
    listCheckRunsForRef: vi.fn(),
    getCombinedStatusForRef: vi.fn(),
    getRequiredStatusChecksForBranch: vi.fn(),
    mergePullRequest: vi.fn(),
    isOrgMember: vi.fn(),
    approveWorkflowRun: vi.fn(),
    listActionRequiredRuns: vi.fn(),
    listWorkflowFiles: vi.fn(),
    listPullRequestFilePaths: vi.fn(),
  },
  tokenProvider: { getToken: vi.fn().mockResolvedValue("token") },
  repoStore: new MockRegisteredRepositoryStore(),
  repoIndexCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
  },
  installationRepositoryCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
  pullRequestUsecase: {
    getCachedPullRequestList: vi.fn(),
    listOpenPullRequests: vi.fn(),
    warmPullRequestListCache: vi.fn().mockResolvedValue({ repoId: "123", items: [], fetchedAt: "" }),
  },
  pullRequestListCache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  },
});

const registeredRepository = {
  repoId: "123",
  owner: "org",
  name: "old-name",
  fullName: "org/old-name",
  htmlUrl: "https://github.com/org/old-name",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const createUsecase = (deps: ReturnType<typeof createDeps>) =>
  new RepositoryAdminUsecaseImpl(
    deps.githubClient,
    deps.tokenProvider,
    deps.repoStore,
    deps.repoIndexCache,
    deps.installationRepositoryCache,
    deps.pullRequestUsecase,
    deps.pullRequestListCache
  );

describe("RepositoryAdminUsecaseImpl", () => {
  it("addRepository が GitHub 照会・KV 登録・index cache 更新・warming を行う", async () => {
    const deps = createDeps();
    const usecase = createUsecase(deps);

    const registered = await usecase.addRepository("org", "repo");

    expect(registered).toMatchObject({ repoId: "123", fullName: "org/repo" });
    await expect(deps.repoStore.getRepository("123")).resolves.toMatchObject({ fullName: "org/repo" });
    expect(deps.repoIndexCache.invalidate).toHaveBeenCalled();
    expect(deps.repoIndexCache.set).toHaveBeenCalled();
    expect(deps.pullRequestUsecase.warmPullRequestListCache).toHaveBeenCalledWith("token", "org", "repo", "123");
  });

  it("addRepository は追加した repo を含む index を cache へ書く", async () => {
    const deps = createDeps();
    const usecase = createUsecase(deps);

    await usecase.addRepository("org", "repo");

    expect(deps.repoIndexCache.set).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ repoId: "123", fullName: "org/repo" })] })
    );
  });

  it("removeRepository は削除した repo を除いた index を cache へ書く", async () => {
    const deps = createDeps();
    const usecase = createUsecase(deps);
    await usecase.addRepository("org", "repo");
    // 削除後に残る repo を用意し、cache へ書かれるのが空 index でないことを確かめる
    await deps.repoStore.addRepository({
      repoId: "456",
      owner: "org",
      name: "other",
      fullName: "org/other",
      htmlUrl: "https://github.com/org/other",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    await usecase.removeRepository("123");

    expect(deps.repoIndexCache.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ repoId: "456", fullName: "org/other" })] })
    );
  });

  it("addRepository は warming が失敗しても登録を成功として返す", async () => {
    const deps = createDeps();
    deps.pullRequestUsecase.warmPullRequestListCache.mockRejectedValue(new Error("warm failed"));
    const usecase = createUsecase(deps);

    await expect(usecase.addRepository("org", "repo")).resolves.toMatchObject({ repoId: "123" });
  });

  it("removeRepository は未登録のとき false を返し cache を触らない", async () => {
    const deps = createDeps();
    const usecase = createUsecase(deps);

    await expect(usecase.removeRepository("999")).resolves.toBe(false);
    expect(deps.repoIndexCache.invalidate).not.toHaveBeenCalled();
    expect(deps.pullRequestListCache.delete).not.toHaveBeenCalled();
  });

  it("removeRepository が KV 削除・index cache 更新・PR cache 削除を行う", async () => {
    const deps = createDeps();
    const usecase = createUsecase(deps);
    await usecase.addRepository("org", "repo");

    await expect(usecase.removeRepository("123")).resolves.toBe(true);
    await expect(deps.repoStore.getRepository("123")).resolves.toBeNull();
    expect(deps.pullRequestListCache.delete).toHaveBeenCalledWith("123");
  });

  it("reconcileRepository は GitHub の現在状態へ収束し index cache と PR cache を無効化する", async () => {
    const deps = createDeps();
    let cachedIndex: RepositoryIndex | null = {
      items: [
        {
          repoId: "123",
          owner: "org",
          name: "old-name",
          fullName: "org/old-name",
          htmlUrl: "https://github.com/org/old-name",
        },
      ],
      updatedAt: "2024-01-01T00:00:00Z",
    };
    deps.repoIndexCache.get.mockImplementation(() => Promise.resolve(cachedIndex));
    deps.repoIndexCache.set.mockImplementation((index: RepositoryIndex) => {
      cachedIndex = index;
      return Promise.resolve();
    });
    deps.repoIndexCache.invalidate.mockImplementation(() => {
      cachedIndex = null;
      return Promise.resolve();
    });
    await deps.repoStore.addRepository({
      repoId: "123",
      owner: "org",
      name: "old-name",
      fullName: "org/old-name",
      htmlUrl: "https://github.com/org/old-name",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    deps.githubClient.getRepositoryById.mockResolvedValue({
      ...gitHubRepository,
      name: "current-c",
      full_name: "org/current-c",
      html_url: "https://github.com/org/current-c",
    });

    const usecase = createUsecase(deps);
    await expect(usecase.reconcileRepository("123", "org")).resolves.toMatchObject({
      type: "synchronized",
      repository: { fullName: "org/current-c" },
    });

    await expect(deps.repoStore.getRepository("123")).resolves.toMatchObject({ fullName: "org/current-c" });
    expect(deps.repoIndexCache.set).not.toHaveBeenCalled();
    await expect(deps.repoIndexCache.get()).resolves.toBeNull();
    await expect(usecase.getRepositoryIndex()).resolves.toMatchObject({
      items: [expect.objectContaining({ repoId: "123", fullName: "org/current-c" })],
    });
    expect(deps.pullRequestListCache.delete).toHaveBeenCalledWith("123");
  });

  it("reconcileRepository は replay されても payload に依存せず GitHub の最新 C を維持する", async () => {
    const deps = createDeps();
    await deps.repoStore.addRepository({
      repoId: "123",
      owner: "org",
      name: "old-a",
      fullName: "org/old-a",
      htmlUrl: "https://github.com/org/old-a",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    deps.githubClient.getRepositoryById.mockResolvedValue({
      ...gitHubRepository,
      name: "current-c",
      full_name: "org/current-c",
      html_url: "https://github.com/org/current-c",
    });
    const usecase = createUsecase(deps);

    await usecase.reconcileRepository("123", "org");
    await usecase.reconcileRepository("123", "org");
    await usecase.reconcileRepository("123", "org");

    await expect(deps.repoStore.getRepository("123")).resolves.toMatchObject({ fullName: "org/current-c" });
    expect(deps.githubClient.getRepositoryById).toHaveBeenCalledTimes(3);
  });

  it("reconcileRepository は org 外へ transfer 済みなら自動登録解除する", async () => {
    const deps = createDeps();
    await deps.repoStore.addRepository({
      repoId: "123",
      owner: "org",
      name: "repo",
      fullName: "org/repo",
      htmlUrl: "https://github.com/org/repo",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    deps.githubClient.getRepositoryById.mockResolvedValue({
      ...gitHubRepository,
      owner: { login: "outside" },
      full_name: "outside/repo",
      html_url: "https://github.com/outside/repo",
    });

    await expect(createUsecase(deps).reconcileRepository("123", "org")).resolves.toEqual({ type: "removed" });
    await expect(deps.repoStore.getRepository("123")).resolves.toBeNull();
    expect(deps.pullRequestListCache.delete).toHaveBeenCalledWith("123");
  });

  it("reconcileRepository は installation から消えた 404 なら自動登録解除する", async () => {
    const deps = createDeps();
    await deps.repoStore.addRepository({
      repoId: "123",
      owner: "org",
      name: "repo",
      fullName: "org/repo",
      htmlUrl: "https://github.com/org/repo",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    deps.githubClient.getRepositoryById.mockRejectedValue(new AppError("repo_not_found", "Not found"));

    await expect(createUsecase(deps).reconcileRepository("123", "org")).resolves.toEqual({ type: "removed" });
    await expect(deps.repoStore.getRepository("123")).resolves.toBeNull();
  });

  it("reconcileRepository は transient GitHub failure で登録や cache を変更しない", async () => {
    const deps = createDeps();
    await deps.repoStore.addRepository({
      repoId: "123",
      owner: "org",
      name: "old-name",
      fullName: "org/old-name",
      htmlUrl: "https://github.com/org/old-name",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    deps.githubClient.getRepositoryById.mockRejectedValue(new AppError("unexpected_github_error", "failed"));

    await expect(createUsecase(deps).reconcileRepository("123", "org")).rejects.toMatchObject({
      type: "unexpected_github_error",
    });
    await expect(deps.repoStore.getRepository("123")).resolves.toMatchObject({ fullName: "org/old-name" });
    expect(deps.repoIndexCache.set).not.toHaveBeenCalled();
    expect(deps.pullRequestListCache.delete).not.toHaveBeenCalled();
  });

  it("reconcileRepository は未登録 repository なら token や GitHub API を呼ばない", async () => {
    const deps = createDeps();

    await expect(createUsecase(deps).reconcileRepository("999", "org")).resolves.toEqual({
      type: "not_registered",
    });
    expect(deps.tokenProvider.getToken).not.toHaveBeenCalled();
    expect(deps.githubClient.getRepositoryById).not.toHaveBeenCalled();
    expect(deps.repoIndexCache.set).not.toHaveBeenCalled();
  });

  it("getRepositoryIndex は cache hit なら KV を読まない", async () => {
    const deps = createDeps();
    const cached = { items: [registeredRepository], updatedAt: "2024-01-01T00:00:00Z" };
    deps.repoIndexCache.get.mockResolvedValue(cached);
    const getRepositoryIndex = vi.spyOn(deps.repoStore, "getRepositoryIndex");
    const usecase = createUsecase(deps);

    await expect(usecase.getRepositoryIndex()).resolves.toBe(cached);

    expect(getRepositoryIndex).not.toHaveBeenCalled();
    expect(deps.repoIndexCache.invalidate).not.toHaveBeenCalled();
    expect(deps.repoIndexCache.set).not.toHaveBeenCalled();
  });

  it("getCachedRepositoryIndex は cache だけを読み、KV を読まない", async () => {
    const deps = createDeps();
    const cached = { items: [registeredRepository], updatedAt: "2024-01-01T00:00:00Z" };
    deps.repoIndexCache.get.mockResolvedValue(cached);
    const getRepositoryIndex = vi.spyOn(deps.repoStore, "getRepositoryIndex");
    const usecase = createUsecase(deps);

    await expect(usecase.getCachedRepositoryIndex()).resolves.toBe(cached);

    expect(getRepositoryIndex).not.toHaveBeenCalled();
  });

  it("getRepositoryIndex は cache miss なら個別 repo key から再構築した index で cache を置換する", async () => {
    const deps = createDeps();
    await deps.repoStore.addRepository({
      repoId: "456",
      owner: "org",
      name: "recovered",
      fullName: "org/recovered",
      htmlUrl: "https://github.com/org/recovered",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    const usecase = createUsecase(deps);

    const rebuilt = await usecase.getRepositoryIndex();

    expect(rebuilt.items).toEqual([expect.objectContaining({ repoId: "456", fullName: "org/recovered" })]);
    expect(deps.repoIndexCache.invalidate).not.toHaveBeenCalled();
    expect(deps.repoIndexCache.set).toHaveBeenCalledWith(rebuilt);
  });

  it("getRepositoryIndex は KV 再構築失敗を空 index として cache しない", async () => {
    const deps = createDeps();
    vi.spyOn(deps.repoStore, "getRepositoryIndex").mockRejectedValueOnce(new Error("list failed"));
    const usecase = createUsecase(deps);

    await expect(usecase.getRepositoryIndex()).rejects.toThrow("list failed");

    expect(deps.repoIndexCache.invalidate).not.toHaveBeenCalled();
    expect(deps.repoIndexCache.set).not.toHaveBeenCalled();
  });

  it("getInstallationRepositories は GitHub から取得した一覧を cache へ書いて返す", async () => {
    const deps = createDeps();
    deps.githubClient.listInstallationRepositories.mockResolvedValue([gitHubRepository]);
    const usecase = createUsecase(deps);

    const result = await usecase.getInstallationRepositories();

    expect(result.items).toEqual([
      { id: 123, owner: "org", name: "repo", fullName: "org/repo", htmlUrl: "https://github.com/org/repo" },
    ]);
    expect(deps.githubClient.listInstallationRepositories).toHaveBeenCalledWith("token");
    expect(deps.installationRepositoryCache.set).toHaveBeenCalledWith(result);
  });
});
