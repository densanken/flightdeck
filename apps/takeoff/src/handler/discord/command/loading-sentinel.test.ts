import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleMerge } from "./merge.js";
import { handlePulls } from "./pulls.js";
import { handleRepoAdd, handleRepoRemove, handleRepoRemoveComponent } from "./repo.js";
import { handleStatus } from "./status.js";
import { handleSync } from "./sync.js";
import { ApplicationCommandOptionType } from "../constants.js";
import { LOADING_VALUE } from "../timeout-budget.js";

import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type {
  APIApplicationCommandInteractionDataBasicOption,
  APIChatInputApplicationCommandInteraction,
  APIEmbed,
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
  FOLLOWUP_TIMEOUT_MS: 10_000,
  get editDeferredResponse() {
    return editDeferredResponseMock;
  },
  get editDeferredWithError() {
    return editDeferredWithErrorMock;
  },
}));

const LOADING_MESSAGE = "候補を読み込み中です。もう一度入力してください。";

let waitUntilPromises: Promise<unknown>[];

const createContext = (): Context<Env> =>
  ({
    env: {
      DISCORD_APPLICATION_ID: "app-id",
      ADMIN_ROLE_IDS: "admin-role",
      GITHUB_ORG: "org",
    },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    },
    json: (value: unknown) => value as Response,
  }) as unknown as Context<Env>;

// autocomplete の読み込み中候補が実行された場合、外部 I/O へ到達してはいけない
// 呼び出し順に依存せず検査できるよう、command から到達しうる I/O をすべて mock に持たせる
const getRepositoryMock = vi.fn<(repoId: string) => Promise<null>>();
const addRepositoryMock = vi.fn();
const removeRepositoryMock = vi.fn();
const getCachedPullRequestListMock = vi.fn();
const mergeMock = vi.fn();
const getStatusMock = vi.fn();
const syncMock = vi.fn();

const externalIoMocks = (): Record<string, ReturnType<typeof vi.fn>> => ({
  "repositoryAdminUsecase.getRepository": getRepositoryMock,
  "repositoryAdminUsecase.addRepository": addRepositoryMock,
  "repositoryAdminUsecase.removeRepository": removeRepositoryMock,
  "pullRequestUsecase.getCachedPullRequestList": getCachedPullRequestListMock,
  "mergeUsecase.merge": mergeMock,
  "statusUsecase.getStatus": getStatusMock,
  "syncUsecase.sync": syncMock,
});

const createDeps = (): DiscordDependencies =>
  ({
    repositoryAdminUsecase: {
      getRepository: getRepositoryMock,
      addRepository: addRepositoryMock,
      removeRepository: removeRepositoryMock,
    },
    pullRequestUsecase: {
      getCachedPullRequestList: getCachedPullRequestListMock,
      listOpenPullRequests: vi.fn(),
    },
    mergeUsecase: { merge: mergeMock },
    statusUsecase: { getStatus: getStatusMock },
    syncUsecase: { sync: syncMock },
  }) as unknown as DiscordDependencies;

const commandInteraction = (options: APIApplicationCommandInteractionDataBasicOption[]) =>
  ({
    data: { name: "command", type: 1, options },
    member: { roles: ["admin-role"], user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  }) as unknown as APIChatInputApplicationCommandInteraction;

const stringOption = (name: string, value: string): APIApplicationCommandInteractionDataBasicOption => ({
  name,
  type: ApplicationCommandOptionType.String,
  value,
});

const componentInteraction = (customId: string) =>
  ({
    data: { custom_id: customId, component_type: 2 },
    member: { roles: ["admin-role"], user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  }) as unknown as APIMessageComponentInteraction;

// component は deferred update で応答するため、error 用の followup ではなく embed の差し替えで案内する
type Delivery = "error" | "update";

const expectLoadingGuidance = (delivery: Delivery): void => {
  if (delivery === "error") {
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith("app-id", "interaction-token", LOADING_MESSAGE);
    expect(editDeferredResponseMock).not.toHaveBeenCalled();
    return;
  }
  expect(editDeferredWithErrorMock).not.toHaveBeenCalled();
  expect(editDeferredResponseMock).toHaveBeenCalledWith(
    "app-id",
    "interaction-token",
    expect.objectContaining({ description: LOADING_MESSAGE }),
    []
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises = [];
});

describe("読み込み中候補のまま実行された command", () => {
  const cases: {
    name: string;
    run: (deps: DiscordDependencies) => void;
    delivery?: Delivery;
  }[] = [
    {
      name: "/merge の repo",
      run: (deps) => {
        handleMerge(
          createContext(),
          commandInteraction([stringOption("repo", LOADING_VALUE), stringOption("pr", "1")]),
          deps
        );
      },
    },
    {
      name: "/merge の pr",
      run: (deps) => {
        handleMerge(
          createContext(),
          commandInteraction([stringOption("repo", "repo-1"), stringOption("pr", LOADING_VALUE)]),
          deps
        );
      },
    },
    {
      name: "/status の repo",
      run: (deps) => {
        handleStatus(
          createContext(),
          commandInteraction([stringOption("repo", LOADING_VALUE), stringOption("pr", "1")]),
          deps
        );
      },
    },
    {
      name: "/status の pr",
      run: (deps) => {
        handleStatus(
          createContext(),
          commandInteraction([stringOption("repo", "repo-1"), stringOption("pr", LOADING_VALUE)]),
          deps
        );
      },
    },
    {
      name: "/sync の repo",
      run: (deps) => {
        handleSync(createContext(), commandInteraction([stringOption("repo", LOADING_VALUE)]), deps);
      },
    },
    {
      name: "/pulls の repo",
      run: (deps) => {
        handlePulls(createContext(), commandInteraction([stringOption("repo", LOADING_VALUE)]), deps);
      },
    },
    {
      name: "/repo add の full_name",
      run: (deps) => {
        handleRepoAdd(createContext(), commandInteraction([]), [stringOption("full_name", LOADING_VALUE)], deps);
      },
    },
    {
      name: "/repo remove の repo",
      run: (deps) => {
        handleRepoRemove(createContext(), commandInteraction([]), [stringOption("repo", LOADING_VALUE)], deps);
      },
    },
    {
      // autocomplete の候補を選んだまま /repo remove を実行すると、確認ボタンの custom_id に sentinel が載る
      name: "/repo remove の確認ボタン",
      run: (deps) => {
        handleRepoRemoveComponent(createContext(), componentInteraction(`repo.remove.confirm:${LOADING_VALUE}`), deps);
      },
      delivery: "update",
    },
  ];

  it.each(cases)("$name は読み込み中を案内し外部 I/O を行わない", async ({ run, delivery = "error" }) => {
    run(createDeps());
    await Promise.all(waitUntilPromises);

    expectLoadingGuidance(delivery);
    for (const [name, mock] of Object.entries(externalIoMocks())) {
      expect(mock, `${name} を呼んではいけない`).not.toHaveBeenCalled();
    }
  });
});
