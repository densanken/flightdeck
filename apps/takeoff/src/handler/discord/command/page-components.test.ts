import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePullsPage } from "./pulls.js";
import { handleReposPage } from "./repos.js";

import type { CachedPullRequestList } from "../../../domain/pull-request.js";
import type { RepositoryIndex } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type {
  APIEmbed,
  APIInteractionResponse,
  APIMessageComponentInteraction,
  APIMessageTopLevelComponent,
} from "discord-api-types/v10";
import type { Context } from "hono";

const editDeferredResponseMock =
  vi.fn<
    (applicationId: string, token: string, embed: APIEmbed, components?: APIMessageTopLevelComponent[]) => Promise<void>
  >();
const editDeferredWithErrorMock = vi.fn<(applicationId: string, token: string, message: string) => Promise<void>>();

vi.mock("../followup.js", () => ({
  get editDeferredResponse() {
    return editDeferredResponseMock;
  },
  get editDeferredWithError() {
    return editDeferredWithErrorMock;
  },
}));

// Discord の message component 応答は 3 秒以内に返す必要があるため、type 6 で確定する
const DEFERRED_MESSAGE_UPDATE = 6;

const index: RepositoryIndex = {
  items: [{ repoId: "repo-1", owner: "org", name: "repo", fullName: "org/repo", htmlUrl: "https://example.com" }],
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const prList: CachedPullRequestList = {
  repoId: "repo-1",
  fetchedAt: "2026-08-12T00:00:00.000Z",
  items: [
    {
      number: 1,
      title: "fix: something",
      htmlUrl: "https://github.com/org/repo/pull/1",
      authorLogin: "user",
      headRef: "feature",
      baseRef: "main",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  ],
};

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

const componentInteraction = (customId: string): APIMessageComponentInteraction =>
  ({
    data: { custom_id: customId, component_type: 2 },
    member: { roles: [], user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  }) as unknown as APIMessageComponentInteraction;

const responseTypeOf = (res: Response): number => (res as unknown as APIInteractionResponse).type;

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises = [];
});

describe("handleReposPage", () => {
  it("deferred update を即時に返し、一覧の取得と編集を followup で行う", async () => {
    const deps = {
      repositoryAdminUsecase: { getRepositoryIndex: vi.fn().mockResolvedValue(index) },
    } as unknown as DiscordDependencies;

    const res = handleReposPage(createContext(), componentInteraction("repos.page:1"), deps);

    expect(responseTypeOf(res)).toBe(DEFERRED_MESSAGE_UPDATE);
    expect(editDeferredResponseMock).not.toHaveBeenCalled();

    await Promise.all(waitUntilPromises);

    const [applicationId, token, embed] = editDeferredResponseMock.mock.calls[0] ?? [];
    expect(applicationId).toBe("app-id");
    expect(token).toBe("interaction-token");
    expect(embed?.title).toBe("登録済みリポジトリ");
  });

  it("followup での失敗を deferred のエラー編集として返す", async () => {
    const deps = {
      repositoryAdminUsecase: { getRepositoryIndex: vi.fn().mockRejectedValue(new Error("kv down")) },
    } as unknown as DiscordDependencies;

    const res = handleReposPage(createContext(), componentInteraction("repos.page:1"), deps);
    await Promise.all(waitUntilPromises);

    expect(responseTypeOf(res)).toBe(DEFERRED_MESSAGE_UPDATE);
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "予期しないエラーが発生しました。"
    );
  });
});

describe("handlePullsPage", () => {
  it("deferred update を即時に返し、PR 一覧の取得と編集を followup で行う", async () => {
    const listOpenPullRequests = vi.fn().mockResolvedValue(prList);
    const deps = {
      repositoryAdminUsecase: {
        getRepository: vi.fn().mockResolvedValue({
          repoId: "repo-1",
          owner: "org",
          name: "repo",
          fullName: "org/repo",
          htmlUrl: "https://example.com",
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        }),
      },
      pullRequestUsecase: { listOpenPullRequests },
    } as unknown as DiscordDependencies;

    const res = handlePullsPage(createContext(), componentInteraction("pulls.page:repo-1:next:1"), deps);

    expect(responseTypeOf(res)).toBe(DEFERRED_MESSAGE_UPDATE);
    expect(editDeferredResponseMock).not.toHaveBeenCalled();

    await Promise.all(waitUntilPromises);

    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.title).toBe("Open PRs: `org/repo`");
    expect(listOpenPullRequests).toHaveBeenCalledWith("org", "repo", "repo-1");
  });

  it("未登録リポジトリの button を deferred のエラー編集として返す", async () => {
    const deps = {
      repositoryAdminUsecase: { getRepository: vi.fn().mockResolvedValue(null) },
      pullRequestUsecase: { listOpenPullRequests: vi.fn() },
    } as unknown as DiscordDependencies;

    handlePullsPage(createContext(), componentInteraction("pulls.page:repo-1:next:1"), deps);
    await Promise.all(waitUntilPromises);

    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "指定されたリポジトリは登録されていません。"
    );
  });
});
