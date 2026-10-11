import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePulls } from "./pulls.js";
import { ApplicationCommandOptionType } from "../constants.js";

import type { CachedPullRequestList } from "../../../domain/pull-request.js";
import type { RegisteredRepository } from "../../../domain/repository.js";
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

const repo: RegisteredRepository = {
  repoId: "1",
  owner: "org",
  name: "repo",
  fullName: "org/repo",
  htmlUrl: "https://github.com/org/repo",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const pullRequests: CachedPullRequestList = {
  repoId: "1",
  fetchedAt: "2026-08-12T00:00:00.000Z",
  items: [
    {
      number: 5,
      title: "fix: something",
      htmlUrl: "https://github.com/org/repo/pull/5",
      authorLogin: "user",
      headRef: "feature",
      baseRef: "main",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  ],
};

const getRepositoryMock = vi.fn<(repoId: string) => Promise<RegisteredRepository | null>>();
const listOpenPullRequestsMock =
  vi.fn<(owner: string, name: string, repoId: string) => Promise<CachedPullRequestList>>();

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
  data: { name: "pulls", type: 1, options: [{ name: "repo", type: ApplicationCommandOptionType.String, value: "1" }] },
  token: "interaction-token",
} as unknown as APIChatInputApplicationCommandInteraction;

const runPulls = async (): Promise<Response> => {
  const deps = {
    repositoryAdminUsecase: { getRepository: getRepositoryMock },
    pullRequestUsecase: { listOpenPullRequests: listOpenPullRequestsMock },
  } as unknown as DiscordDependencies;
  const res = handlePulls(createContext(), interaction, deps);
  await Promise.all(waitUntilPromises);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises = [];
});

describe("handlePulls", () => {
  it("deferred で応答し、指定したリポジトリの open PR 一覧を followup で送る", async () => {
    getRepositoryMock.mockResolvedValue(repo);
    listOpenPullRequestsMock.mockResolvedValue(pullRequests);

    const res = await runPulls();

    expect((res as unknown as APIInteractionResponse).type).toBe(DEFERRED_CHANNEL_MESSAGE);
    expect(listOpenPullRequestsMock).toHaveBeenCalledWith("org", "repo", "1");
    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.description).toContain("[fix: something (#5)](https://github.com/org/repo/pull/5)");
    expect(editDeferredWithErrorMock).not.toHaveBeenCalled();
  });

  it("PR 一覧の読み込みに失敗したらエラーの followup を送る", async () => {
    getRepositoryMock.mockResolvedValue(repo);
    listOpenPullRequestsMock.mockRejectedValue(new Error("github down"));

    const res = await runPulls();

    expect((res as unknown as APIInteractionResponse).type).toBe(DEFERRED_CHANNEL_MESSAGE);
    expect(editDeferredResponseMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "予期しないエラーが発生しました。"
    );
  });
});
