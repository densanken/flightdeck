import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleRepos } from "./repos.js";

import type { RepositoryIndex } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type {
  APIChatInputApplicationCommandInteraction,
  APIEmbed,
  APIInteractionResponse,
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

// slash command は deferred の ephemeral 応答（type 5）で確定し、本体を followup へ回す
const DEFERRED_CHANNEL_MESSAGE = 5;

const index: RepositoryIndex = {
  items: [{ repoId: "1", owner: "org", name: "repo", fullName: "org/repo", htmlUrl: "https://github.com/org/repo" }],
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const getRepositoryIndexMock = vi.fn<() => Promise<RepositoryIndex>>();

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

const interaction = {
  data: { name: "repos", type: 1 },
  token: "interaction-token",
} as unknown as APIChatInputApplicationCommandInteraction;

const runRepos = async (): Promise<Response> => {
  const deps = {
    repositoryAdminUsecase: { getRepositoryIndex: getRepositoryIndexMock },
  } as unknown as DiscordDependencies;
  const res = handleRepos(createContext(), interaction, deps);
  await Promise.all(waitUntilPromises);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises = [];
});

describe("handleRepos", () => {
  it("deferred で応答し、登録済みリポジトリの一覧を followup で送る", async () => {
    getRepositoryIndexMock.mockResolvedValue(index);

    const res = await runRepos();

    expect((res as unknown as APIInteractionResponse).type).toBe(DEFERRED_CHANNEL_MESSAGE);
    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.description).toContain("[org/repo](https://github.com/org/repo)");
    expect(editDeferredWithErrorMock).not.toHaveBeenCalled();
  });

  it("一覧の読み込みに失敗したらエラーの followup を送る", async () => {
    getRepositoryIndexMock.mockRejectedValue(new Error("kv down"));

    const res = await runRepos();

    expect((res as unknown as APIInteractionResponse).type).toBe(DEFERRED_CHANNEL_MESSAGE);
    expect(editDeferredResponseMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "予期しないエラーが発生しました。"
    );
  });
});
