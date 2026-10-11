import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSync } from "./sync.js";
import { EmbedColor } from "../interaction-response.js";

import type { CachedPullRequestList } from "../../../domain/pull-request.js";
import type { RegisteredRepository } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { APIChatInputApplicationCommandInteraction, APIEmbed } from "discord-api-types/v10";
import type { Context } from "hono";

const editDeferredResponseMock = vi.fn<(applicationId: string, token: string, embed: APIEmbed) => Promise<void>>();
const editDeferredWithErrorMock = vi.fn<(applicationId: string, token: string, message: string) => Promise<void>>();

vi.mock("../followup.js", () => ({
  get editDeferredResponse() {
    return editDeferredResponseMock;
  },
  get editDeferredWithError() {
    return editDeferredWithErrorMock;
  },
}));

const testRepo: RegisteredRepository = {
  repoId: "repo-1",
  owner: "org",
  name: "repo",
  fullName: "org/repo",
  htmlUrl: "https://github.com/org/repo",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const getRepositoryMock = vi.fn<(repoId: string) => Promise<RegisteredRepository | null>>();
const syncMock = vi.fn<(repo: RegisteredRepository, discordUserId: string) => Promise<CachedPullRequestList>>();

let waitUntilPromises: Promise<unknown>[];

const createContext = (): Context<Env> =>
  ({
    env: { DISCORD_APPLICATION_ID: "app-id" },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    },
    json: (value: unknown) => value as Response,
  }) as unknown as Context<Env>;

const createDeps = (): DiscordDependencies =>
  ({
    repositoryAdminUsecase: { getRepository: getRepositoryMock },
    syncUsecase: { sync: syncMock },
  }) as unknown as DiscordDependencies;

const createInteraction = (options: { repo?: string }): APIChatInputApplicationCommandInteraction => {
  const dataOptions = [];
  if (options.repo !== undefined) dataOptions.push({ name: "repo", type: 3, value: options.repo });
  return {
    data: { name: "sync", type: 1, options: dataOptions },
    member: { roles: [], user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  } as unknown as APIChatInputApplicationCommandInteraction;
};

const runHandler = async (interaction: APIChatInputApplicationCommandInteraction): Promise<void> => {
  handleSync(createContext(), interaction, createDeps());
  await Promise.all(waitUntilPromises);
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises = [];
  getRepositoryMock.mockResolvedValue(testRepo);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSync", () => {
  it("成功時に open PR 数を含む success embed を出す", async () => {
    syncMock.mockResolvedValue({
      repoId: "repo-1",
      fetchedAt: "2024-01-01T00:00:00Z",
      items: [
        { number: 1, title: "a", htmlUrl: "u", authorLogin: "x", headRef: "h", baseRef: "b", updatedAt: "t" },
        { number: 2, title: "b", htmlUrl: "u", authorLogin: "x", headRef: "h", baseRef: "b", updatedAt: "t" },
      ],
    });

    await runHandler(createInteraction({ repo: "repo-1" }));

    expect(syncMock).toHaveBeenCalledWith(testRepo, "user-1");
    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed).toMatchObject({
      title: "キャッシュを更新しました",
      color: EmbedColor.Success,
      fields: [
        { name: "Repository", value: "`org/repo`" },
        { name: "Open PRs", value: "2 件" },
      ],
    });
  });

  it("repo が未指定のとき usecase を呼ばずエラーを返す", async () => {
    await runHandler(createInteraction({}));

    expect(syncMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "repo が指定されていません。"
    );
  });

  it("未登録リポジトリのとき repo_not_registered の日本語メッセージを返す", async () => {
    getRepositoryMock.mockResolvedValue(null);

    await runHandler(createInteraction({ repo: "unknown" }));

    expect(syncMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "指定されたリポジトリは登録されていません。"
    );
  });
});
