import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { composeDependencyGraph } from "./shared.js";
import { buildCacheBaseUrl } from "../config.js";
import { githubAppAuth } from "../infrastructure/github/app-auth.js";

import type { Env } from "../env.js";

const bindings = (publicBaseUrl = "https://takeoff.example.com"): Env["Bindings"] => ({
  ...env,
  GITHUB_APP_PRIVATE_KEY: "private-key",
  DISCORD_PUBLIC_KEY: "public-key",
  DISCORD_APPLICATION_ID: "application-id",
  MERGE_AUDIT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token",
  GITHUB_APP_ID: "github-app-id",
  GITHUB_ORG: "org",
  ALLOWED_GUILD_IDS: "guild-id",
  ADMIN_ROLE_IDS: "role-id",
  PUBLIC_BASE_URL: publicBaseUrl,
});

const wiring = (value: object): Readonly<Record<string, unknown>> => value as Readonly<Record<string, unknown>>;

describe("composeDependencyGraph", () => {
  it("reconcile の GitHub 待機中に登録解除が完了しても、実 KV の登録と index を復活させない", async () => {
    const graph = composeDependencyGraph(bindings());
    const repository = {
      repoId: "123",
      owner: "org",
      name: "before",
      fullName: "org/before",
      htmlUrl: "https://github.com/org/before",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    await graph.repoStore.addRepository(repository);
    const registered = await graph.repoStore.getRepository("123");
    if (!registered) throw new Error("Missing registered repository");
    vi.spyOn(graph.tokenProvider, "getToken").mockResolvedValue("token");
    let resumeGitHub: () => void = vi.fn();
    let notifyGitHubStarted: () => void = vi.fn();
    const gitHubStarted = new Promise<void>((resolve) => {
      notifyGitHubStarted = resolve;
    });
    const gitHubResponse = new Promise<void>((resolve) => {
      resumeGitHub = resolve;
    });
    vi.spyOn(graph.githubClient, "getRepositoryById").mockImplementation(async () => {
      notifyGitHubStarted();
      await gitHubResponse;
      return {
        id: 123,
        owner: { login: "org" },
        name: "renamed",
        full_name: "org/renamed",
        html_url: "https://github.com/org/renamed",
      };
    });
    const setIndex = vi.spyOn(graph.repoIndexCache, "set");

    const reconcile = graph.repositoryAdminUsecase.reconcileRepository("123", "org");
    await gitHubStarted;
    await expect(graph.repositoryAdminUsecase.removeRepository("123")).resolves.toBe(true);
    setIndex.mockClear();
    resumeGitHub();
    await reconcile;

    await expect(env.KV.get("repo:123")).resolves.toBeNull();
    await expect(env.KV.get(`repo-metadata:123:${registered.registrationId}`, "json")).resolves.toMatchObject({
      name: "renamed",
    });
    await expect(graph.repoStore.getRepository("123")).resolves.toBeNull();
    await expect(graph.repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [] });
    expect(setIndex).not.toHaveBeenCalled();
    await expect(graph.repoIndexCache.get()).resolves.toBeNull();
    await expect(graph.repositoryAdminUsecase.getRepositoryIndex()).resolves.toMatchObject({ items: [] });
  });

  it("全 usecase を同じ graph の adapter と usecase へ配線する", () => {
    const graph = composeDependencyGraph(bindings());

    expect(wiring(graph.pullRequestUsecase)).toMatchObject({
      client: graph.githubClient,
      cache: graph.pullRequestListCache,
    });
    expect(wiring(graph.mergeUsecase)).toMatchObject({
      githubClient: graph.githubClient,
      repoStore: graph.repoStore,
      cooldownCache: graph.mergeCooldownCache,
      pullRequestUsecase: graph.pullRequestUsecase,
      auditNotifier: graph.auditNotifier,
      autoApproveUsecase: graph.autoApproveUsecase,
    });
    expect(wiring(graph.statusUsecase)).toMatchObject({
      githubClient: graph.githubClient,
      repoStore: graph.repoStore,
      autoApproveUsecase: graph.autoApproveUsecase,
    });
    expect(wiring(graph.autoApproveUsecase)).toMatchObject({
      client: graph.githubClient,
      tokenProvider: graph.tokenProvider,
      repoStore: graph.repoStore,
      githubOrg: "org",
    });
    expect(wiring(graph.repositoryAdminUsecase)).toMatchObject({
      githubClient: graph.githubClient,
      tokenProvider: graph.tokenProvider,
      repoStore: graph.repoStore,
      repoIndexCache: graph.repoIndexCache,
      installationRepositoryCache: graph.installationRepositoryCache,
      pullRequestUsecase: graph.pullRequestUsecase,
      pullRequestListCache: graph.pullRequestListCache,
    });
    expect(wiring(graph.syncUsecase)).toMatchObject({
      tokenProvider: graph.tokenProvider,
      syncCooldownCache: graph.syncCooldownCache,
      pullRequestUsecase: graph.pullRequestUsecase,
    });
  });

  it("request ごとの env から独立した graph と cache namespace を構築する", () => {
    const first = composeDependencyGraph(bindings("https://first.example.com"));
    const second = composeDependencyGraph(bindings("https://second.example.com"));

    expect(first).not.toBe(second);
    expect(first.githubClient).not.toBe(second.githubClient);
    expect(first.repoStore).not.toBe(second.repoStore);
    expect(first.pullRequestUsecase).not.toBe(second.pullRequestUsecase);
    expect(wiring(first.pullRequestListCache).cacheBaseUrl).toBe(buildCacheBaseUrl("https://first.example.com"));
    expect(wiring(second.pullRequestListCache).cacheBaseUrl).toBe(buildCacheBaseUrl("https://second.example.com"));
  });

  it("request ごとの GitHub App 設定と KV binding をそれぞれの graph に閉じ込める", async () => {
    const firstGet = vi.fn().mockResolvedValue(null);
    const secondGet = vi.fn().mockResolvedValue(null);
    const firstKv = { get: firstGet } as unknown as KVNamespace;
    const secondKv = { get: secondGet } as unknown as KVNamespace;
    const getAuthenticatedToken = vi.spyOn(githubAppAuth, "getAuthenticatedToken").mockResolvedValue("token");
    const firstEnv = {
      ...bindings("https://first.example.com"),
      KV: firstKv,
      GITHUB_APP_ID: "first-app-id",
      GITHUB_APP_PRIVATE_KEY: "first-private-key",
      GITHUB_ORG: "first-org",
    };
    const secondEnv = {
      ...bindings("https://second.example.com"),
      KV: secondKv,
      GITHUB_APP_ID: "second-app-id",
      GITHUB_APP_PRIVATE_KEY: "second-private-key",
      GITHUB_ORG: "second-org",
    };

    const first = composeDependencyGraph(firstEnv);
    const second = composeDependencyGraph(secondEnv);

    await first.tokenProvider.getToken();
    await second.tokenProvider.getToken();
    await first.repoStore.getRepository("1");
    await second.repoStore.getRepository("2");

    expect(getAuthenticatedToken).toHaveBeenNthCalledWith(
      1,
      "first-app-id",
      "first-private-key",
      "first-org",
      buildCacheBaseUrl("https://first.example.com")
    );
    expect(getAuthenticatedToken).toHaveBeenNthCalledWith(
      2,
      "second-app-id",
      "second-private-key",
      "second-org",
      buildCacheBaseUrl("https://second.example.com")
    );
    expect(firstGet).toHaveBeenCalledWith("repo:1", "json");
    expect(secondGet).toHaveBeenCalledWith("repo:2", "json");
  });
});
