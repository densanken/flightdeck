import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRepoAdd, handleRepoRemove, handleRepoRemoveComponent } from "./repo.js";
import { ApplicationCommandOptionType } from "../constants.js";
import { EmbedColor } from "../interaction-response.js";

import type { RegisteredRepository } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type {
  APIApplicationCommandInteractionDataBasicOption,
  APIChatInputApplicationCommandInteraction,
  APIEmbed,
  APIInteractionResponse,
  APIInteractionResponseUpdateMessage,
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

const ROLE_REQUIRED_MESSAGE = "この操作は管理担当者のみが行うことができます。";

const testRepo: RegisteredRepository = {
  repoId: "repo-1",
  owner: "org",
  name: "repo",
  fullName: "org/repo",
  htmlUrl: "https://github.com/org/repo",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const addRepositoryMock = vi.fn<(owner: string, name: string) => Promise<RegisteredRepository>>();
const removeRepositoryMock = vi.fn<(repoId: string) => Promise<RegisteredRepository | null>>();
const getRepositoryMock = vi.fn<(repoId: string) => Promise<RegisteredRepository | null>>();

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

const createDeps = (): DiscordDependencies =>
  ({
    repositoryAdminUsecase: {
      addRepository: addRepositoryMock,
      removeRepository: removeRepositoryMock,
      getRepository: getRepositoryMock,
    },
  }) as unknown as DiscordDependencies;

const createCommandInteraction = (roles: string[]): APIChatInputApplicationCommandInteraction =>
  ({
    data: { name: "repo", type: 1 },
    member: { roles, user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  }) as unknown as APIChatInputApplicationCommandInteraction;

const createComponentInteraction = (roles: string[], customId: string): APIMessageComponentInteraction =>
  ({
    data: { custom_id: customId, component_type: 2 },
    member: { roles, user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  }) as unknown as APIMessageComponentInteraction;

const stringOptions = (values: {
  full_name?: string;
  repo?: string;
}): APIApplicationCommandInteractionDataBasicOption[] => {
  const opts: APIApplicationCommandInteractionDataBasicOption[] = [];
  if (values.full_name !== undefined) {
    opts.push({ name: "full_name", type: ApplicationCommandOptionType.String, value: values.full_name });
  }
  if (values.repo !== undefined) {
    opts.push({ name: "repo", type: ApplicationCommandOptionType.String, value: values.repo });
  }
  return opts;
};

const runAdd = async (
  interaction: APIChatInputApplicationCommandInteraction,
  opts: APIApplicationCommandInteractionDataBasicOption[]
): Promise<void> => {
  handleRepoAdd(createContext(), interaction, opts, createDeps());
  await Promise.all(waitUntilPromises);
};

const runRemove = async (
  interaction: APIChatInputApplicationCommandInteraction,
  opts: APIApplicationCommandInteractionDataBasicOption[]
): Promise<void> => {
  handleRepoRemove(createContext(), interaction, opts, createDeps());
  await Promise.all(waitUntilPromises);
};

// Discord の message component 応答は 3 秒以内に返す必要があるため、type 6 で確定する
const DEFERRED_MESSAGE_UPDATE = 6;

const responseTypeOf = (res: Response): number => (res as unknown as APIInteractionResponse).type;

const embedOf = (res: Response): APIEmbed => {
  const response = res as unknown as APIInteractionResponseUpdateMessage;
  const embed = response.data?.embeds?.[0];
  if (!embed) throw new Error("response has no embed");
  return embed;
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleRepoAdd", () => {
  it("非 admin は role gate で拒否し addRepository を呼ばない", async () => {
    await runAdd(createCommandInteraction([]), stringOptions({ full_name: "org/repo" }));

    expect(addRepositoryMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith("app-id", "interaction-token", ROLE_REQUIRED_MESSAGE);
  });

  it("org 外の owner は addRepository を呼ばず org スコープを強制する", async () => {
    await runAdd(createCommandInteraction(["admin-role"]), stringOptions({ full_name: "other/repo" }));

    expect(addRepositoryMock).not.toHaveBeenCalled();
    const message = editDeferredWithErrorMock.mock.calls[0]?.[2] ?? "";
    expect(message).toContain("organization 配下");
  });

  it.each(["a/b/c", "org/", "/repo", "org/repo/extra"])(
    "repo または owner/repo 形式でない full_name %j は addRepository を呼ばない",
    async (fullName) => {
      await runAdd(createCommandInteraction(["admin-role"]), stringOptions({ full_name: fullName }));

      expect(addRepositoryMock).not.toHaveBeenCalled();
      expect(editDeferredWithErrorMock).toHaveBeenCalled();
    }
  );

  it("full_name 未指定のとき addRepository を呼ばずエラーを返す", async () => {
    await runAdd(createCommandInteraction(["admin-role"]), stringOptions({}));

    expect(addRepositoryMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalled();
  });

  it("admin かつ org 配下の full_name で addRepository を owner/repo で呼ぶ", async () => {
    addRepositoryMock.mockResolvedValue(testRepo);

    await runAdd(createCommandInteraction(["admin-role"]), stringOptions({ full_name: "org/repo" }));

    expect(addRepositoryMock).toHaveBeenCalledWith("org", "repo");
    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.color).toBe(EmbedColor.Success);
    expect(embed?.description).toBe("`org/repo` を登録しました。");
    expect(editDeferredWithErrorMock).not.toHaveBeenCalled();
  });

  it("owner は大文字小文字を区別せずに org と照合する", async () => {
    addRepositoryMock.mockResolvedValue(testRepo);

    await runAdd(createCommandInteraction(["admin-role"]), stringOptions({ full_name: "ORG/repo" }));

    expect(addRepositoryMock).toHaveBeenCalledWith("ORG", "repo");
    expect(editDeferredWithErrorMock).not.toHaveBeenCalled();
  });

  it("owner を省いた repository 名は org 配下として addRepository を呼ぶ", async () => {
    addRepositoryMock.mockResolvedValue(testRepo);
    // autocomplete の value は 100 文字上限に収めるため repository 名だけになる
    const longName = "r".repeat(100);

    await runAdd(createCommandInteraction(["admin-role"]), stringOptions({ full_name: longName }));

    expect(addRepositoryMock).toHaveBeenCalledWith("org", longName);
    expect(editDeferredWithErrorMock).not.toHaveBeenCalled();
  });
});

describe("handleRepoRemove", () => {
  it("非 admin は role gate で拒否し getRepository を呼ばない", async () => {
    await runRemove(createCommandInteraction([]), stringOptions({ repo: "repo-1" }));

    expect(getRepositoryMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith("app-id", "interaction-token", ROLE_REQUIRED_MESSAGE);
  });

  it("admin かつ登録済み repo で確認/キャンセルボタン付き embed を出す", async () => {
    getRepositoryMock.mockResolvedValue(testRepo);

    await runRemove(createCommandInteraction(["admin-role"]), stringOptions({ repo: "repo-1" }));

    expect(editDeferredResponseMock.mock.calls[0]?.[2]?.description).toBe("`org/repo` をマージ対象から外します。");
    const components = editDeferredResponseMock.mock.calls[0]?.[3];
    const json = JSON.stringify(components);
    expect(json).toContain("repo.remove.confirm:repo-1");
    expect(json).toContain("repo.remove.cancel:repo-1");
  });

  it("admin だが未登録 repo のときエラーを返す", async () => {
    getRepositoryMock.mockResolvedValue(null);

    await runRemove(createCommandInteraction(["admin-role"]), stringOptions({ repo: "missing" }));

    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "指定されたリポジトリは登録されていません。"
    );
  });
});

describe("handleRepoRemoveComponent", () => {
  const runComponent = async (interaction: APIMessageComponentInteraction): Promise<Response> => {
    const res = handleRepoRemoveComponent(createContext(), interaction, createDeps());
    await Promise.all(waitUntilPromises);
    return res;
  };

  it("confirm ボタンを非 admin が押しても removeRepository を呼ばずエラー embed を返す", async () => {
    // repo.ts の role 再検証を守る回帰テスト
    // この検証を消すと removeRepository が呼ばれてしまう
    getRepositoryMock.mockResolvedValue(testRepo);

    const res = await runComponent(createComponentInteraction([], "repo.remove.confirm:repo-1"));

    expect(removeRepositoryMock).not.toHaveBeenCalled();
    expect(responseTypeOf(res)).toBe(DEFERRED_MESSAGE_UPDATE);
    const [, , embed, components] = editDeferredResponseMock.mock.calls[0] ?? [];
    expect(embed?.title).toBe("エラー");
    expect(embed?.description).toBe(ROLE_REQUIRED_MESSAGE);
    expect(embed?.color).toBe(EmbedColor.Error);
    expect(components).toEqual([]);
  });

  it("confirm ボタンは deferred update を即時に返し、削除を followup で行う", async () => {
    getRepositoryMock.mockResolvedValue(testRepo);
    removeRepositoryMock.mockResolvedValue(testRepo);

    const res = handleRepoRemoveComponent(
      createContext(),
      createComponentInteraction(["admin-role"], "repo.remove.confirm:repo-1"),
      createDeps()
    );

    // 3 秒の制限時間内に応答するため、KV 操作前に応答を確定する
    expect(responseTypeOf(res)).toBe(DEFERRED_MESSAGE_UPDATE);
    expect(removeRepositoryMock).not.toHaveBeenCalled();

    await Promise.all(waitUntilPromises);

    expect(removeRepositoryMock).toHaveBeenCalledWith("repo-1");
    const [, , embed, components] = editDeferredResponseMock.mock.calls[0] ?? [];
    expect(embed?.color).toBe(EmbedColor.Success);
    expect(embed?.description).toBe("`org/repo` の登録を解除しました。");
    // 解除済みの確認ボタンを残さない
    expect(components).toEqual([]);
  });

  it("cancel ボタンは role チェック前に同期のキャンセル応答を返し removeRepository を呼ばない", async () => {
    const res = await runComponent(createComponentInteraction([], "repo.remove.cancel:repo-1"));

    expect(removeRepositoryMock).not.toHaveBeenCalled();
    expect(getRepositoryMock).not.toHaveBeenCalled();
    expect(embedOf(res).title).toBe("リポジトリの登録解除をキャンセルしました");
  });
});
