import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRepoAddAutocomplete } from "./installation-repo.js";
import { handlePrAutocomplete } from "./pr.js";
import { handleRepoAutocomplete } from "./repo.js";
import { resetSingleFlight } from "../single-flight.js";
import { AUTOCOMPLETE_TIMEOUT_MS, LOADING_VALUE } from "../timeout-budget.js";

import type { CachedPullRequestList } from "../../../domain/pull-request.js";
import type { RepositoryIndex } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { CachedInstallationRepositoryList } from "../../../repository/cache/interface.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { APIApplicationCommandOptionChoice } from "discord-api-types/v10";
import type { Context } from "hono";

interface AutocompleteResponseBody {
  type: number;
  data: { choices: APIApplicationCommandOptionChoice[] };
}

const index: RepositoryIndex = {
  items: [{ repoId: "repo-1", owner: "org", name: "repo", fullName: "org/repo", htmlUrl: "https://example.com" }],
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const installationRepositories: CachedInstallationRepositoryList = {
  items: [],
  fetchedAt: "2026-08-12T00:00:00.000Z",
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
    env: { GITHUB_ORG: "org" },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    },
    json: (value: unknown) => value as Response,
  }) as unknown as Context<Env>;

// 制限時間を確実に超える読み込みを模す
const SLOW_MS = AUTOCOMPLETE_TIMEOUT_MS + 500;

// 制限時間内に応答したことの判定に使う
// CI の実行時間のばらつきで失敗しない程度の余裕を持たせる
const RESPONSE_DEADLINE_MS = AUTOCOMPLETE_TIMEOUT_MS + 300;

const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const bodyOf = (res: Response): AutocompleteResponseBody => res as unknown as AutocompleteResponseBody;

const expectLoadingChoice = (res: Response): void => {
  const choices = bodyOf(res).data.choices;
  expect(choices).toHaveLength(1);
  expect(choices[0]?.value).toBe(LOADING_VALUE);
  expect(String(choices[0]?.name)).toContain("読み込み中");
};

beforeEach(() => {
  waitUntilPromises = [];
  // in-flight は isolate 内で共有されるため、前の test の warming を持ち越さない
  resetSingleFlight();
  vi.spyOn(console, "warn").mockImplementation(() => {
    // 超過の記録は timeout-budget.test.ts で検証する
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleRepoAutocomplete", () => {
  it("cache hit のときは KV の全件 list を行わず候補を返す", async () => {
    const getRepositoryIndex = vi.fn();
    const deps = {
      repositoryAdminUsecase: {
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(index),
        getRepositoryIndex,
      },
    } as unknown as DiscordDependencies;

    const res = await handleRepoAutocomplete(createContext(), "", deps);

    expect(getRepositoryIndex).not.toHaveBeenCalled();
    expect(bodyOf(res).data.choices).toEqual([{ name: "org/repo", value: "repo-1" }]);
  });

  it("cache miss の読み込みが制限時間を超えたら読み込み中候補を返し warming を waitUntil へ回す", async () => {
    const getRepositoryIndex = vi.fn().mockImplementation(() => after(SLOW_MS, index));
    const deps = {
      repositoryAdminUsecase: {
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(null),
        getRepositoryIndex,
      },
    } as unknown as DiscordDependencies;

    const startedAt = Date.now();
    const res = await handleRepoAutocomplete(createContext(), "", deps);

    expect(Date.now() - startedAt).toBeLessThan(RESPONSE_DEADLINE_MS);
    expectLoadingChoice(res);
    expect(waitUntilPromises).toHaveLength(1);

    // 応答後の warming で cache が温まる
    await Promise.all(waitUntilPromises);
    expect(getRepositoryIndex).toHaveBeenCalledOnce();
  });

  it("cache 読み出しが制限時間を超えたら待たずに読み込み中を返し、本体の読み込みで cache を温める", async () => {
    // Cache API は signal を受け取らないため、制限時間の対象にしないと 3 秒を超えても待ち続ける
    const getRepositoryIndex = vi.fn().mockResolvedValue(index);
    const deps = {
      repositoryAdminUsecase: {
        getCachedRepositoryIndex: vi
          .fn()
          .mockImplementationOnce(() => never<RepositoryIndex | null>())
          .mockResolvedValue(null),
        getRepositoryIndex,
      },
    } as unknown as DiscordDependencies;

    const startedAt = Date.now();
    const res = await handleRepoAutocomplete(createContext(), "", deps);

    expect(Date.now() - startedAt).toBeLessThan(RESPONSE_DEADLINE_MS);
    expectLoadingChoice(res);
    expect(waitUntilPromises).toHaveLength(1);

    await Promise.all(waitUntilPromises);
    expect(getRepositoryIndex).toHaveBeenCalledTimes(1);
  });

  it("1 文字入力ごとの interaction が重なっても KV の全件 list は 1 本にまとめられる", async () => {
    const getRepositoryIndex = vi.fn().mockImplementation(() => after(SLOW_MS, index));
    const deps = {
      repositoryAdminUsecase: {
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(null),
        getRepositoryIndex,
      },
    } as unknown as DiscordDependencies;

    // "re" と打つと 2 回の interaction が発火する
    // 1 本目の warming が走っている間に 2 本目が届く
    const first = handleRepoAutocomplete(createContext(), "r", deps);
    const second = handleRepoAutocomplete(createContext(), "re", deps);
    for (const res of await Promise.all([first, second])) {
      expectLoadingChoice(res);
    }

    await Promise.all(waitUntilPromises);
    expect(getRepositoryIndex).toHaveBeenCalledTimes(1);
  });

  it("読み込みの失敗を記録して空候補へ degrade する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // 記録内容だけを検証する
    });
    const deps = {
      repositoryAdminUsecase: {
        getCachedRepositoryIndex: vi.fn().mockRejectedValue(new Error("cache down")),
        getRepositoryIndex: vi.fn(),
      },
    } as unknown as DiscordDependencies;

    const res = await handleRepoAutocomplete(createContext(), "", deps);

    expect(bodyOf(res).data.choices).toEqual([]);
    expect(error).toHaveBeenCalledWith("discord_autocomplete_failed", {
      label: "repo",
      error: "Error: cache down",
    });
  });
});

describe("handlePrAutocomplete", () => {
  it("PR 一覧の cache hit では GitHub から読み込まない", async () => {
    const listOpenPullRequests = vi.fn();
    const deps = {
      repositoryAdminUsecase: { getCachedRepositoryIndex: vi.fn().mockResolvedValue(index) },
      pullRequestUsecase: {
        getCachedPullRequestList: vi.fn().mockResolvedValue(prList),
        listOpenPullRequests,
      },
    } as unknown as DiscordDependencies;

    const res = await handlePrAutocomplete(createContext(), "repo-1", "", deps);

    expect(listOpenPullRequests).not.toHaveBeenCalled();
    expect(bodyOf(res).data.choices).toEqual([{ name: "#1 fix: something", value: "1" }]);
  });

  it("repository index が cache miss のときは読み込み中を案内し、index の読み込みを起動する", async () => {
    // repo を貼り付けで直接入力した場合、repo の autocomplete は動かない
    // ここで温めないと、index を温める経路が他にない
    const getRepositoryIndex = vi.fn().mockResolvedValue(index);
    const deps = {
      repositoryAdminUsecase: {
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(null),
        getRepositoryIndex,
      },
    } as unknown as DiscordDependencies;

    const res = await handlePrAutocomplete(createContext(), "repo-1", "", deps);

    expectLoadingChoice(res);
    expect(waitUntilPromises).toHaveLength(1);

    await Promise.all(waitUntilPromises);
    expect(getRepositoryIndex).toHaveBeenCalledTimes(1);
  });

  it("repo に読み込み中候補を選んだままの repoId は、空候補ではなく読み込み中を案内する", async () => {
    const getIndexCache = vi.fn();
    const deps = {
      repositoryAdminUsecase: { getCachedRepositoryIndex: getIndexCache },
    } as unknown as DiscordDependencies;

    const res = await handlePrAutocomplete(createContext(), LOADING_VALUE, "", deps);

    expectLoadingChoice(res);
    // sentinel は repoId ではないため、cache も外部 I/O も引かない
    expect(getIndexCache).not.toHaveBeenCalled();
    expect(waitUntilPromises).toHaveLength(0);
  });

  it("PR 一覧の cache 読み出しが制限時間を超えたら待たずに読み込み中を返し、本体の読み込みで温める", async () => {
    const listOpenPullRequests = vi.fn().mockResolvedValue(prList);
    const deps = {
      repositoryAdminUsecase: { getCachedRepositoryIndex: vi.fn().mockResolvedValue(index) },
      pullRequestUsecase: {
        getCachedPullRequestList: vi.fn().mockImplementation(() => never<CachedPullRequestList | null>()),
        listOpenPullRequests,
      },
    } as unknown as DiscordDependencies;

    const startedAt = Date.now();
    const res = await handlePrAutocomplete(createContext(), "repo-1", "", deps);

    expect(Date.now() - startedAt).toBeLessThan(RESPONSE_DEADLINE_MS);
    expectLoadingChoice(res);
    expect(waitUntilPromises).toHaveLength(1);

    await Promise.all(waitUntilPromises);
    expect(listOpenPullRequests).toHaveBeenCalledWith("org", "repo", "repo-1");
  });

  it("PR 一覧取得が制限時間を超えたら読み込み中候補を返し warming を waitUntil へ回す", async () => {
    const listOpenPullRequests = vi.fn().mockImplementation(() => after(SLOW_MS, prList));
    const deps = {
      repositoryAdminUsecase: { getCachedRepositoryIndex: vi.fn().mockResolvedValue(index) },
      pullRequestUsecase: {
        getCachedPullRequestList: vi.fn().mockResolvedValue(null),
        listOpenPullRequests,
      },
    } as unknown as DiscordDependencies;

    const startedAt = Date.now();
    const res = await handlePrAutocomplete(createContext(), "repo-1", "", deps);

    expect(Date.now() - startedAt).toBeLessThan(RESPONSE_DEADLINE_MS);
    expectLoadingChoice(res);
    expect(listOpenPullRequests).toHaveBeenCalledOnce();
    expect(waitUntilPromises).toHaveLength(1);

    // 打ち切った読み込みはそのまま継続し、PR 一覧の cache を温める
    await Promise.all(waitUntilPromises);
    expect(listOpenPullRequests).toHaveBeenCalledWith("org", "repo", "repo-1");
  });

  it("PR 一覧の読み込みの失敗を記録して空候補へ degrade する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // 記録内容だけを検証する
    });
    const deps = {
      repositoryAdminUsecase: { getCachedRepositoryIndex: vi.fn().mockResolvedValue(index) },
      pullRequestUsecase: {
        getCachedPullRequestList: vi.fn().mockRejectedValue(new Error("pr list down")),
      },
    } as unknown as DiscordDependencies;

    const res = await handlePrAutocomplete(createContext(), "repo-1", "", deps);

    expect(bodyOf(res).data.choices).toEqual([]);
    expect(error).toHaveBeenCalledWith("discord_autocomplete_failed", {
      label: "pr",
      error: "Error: pr list down",
    });
  });
});

describe("handleRepoAddAutocomplete", () => {
  it("2 段の読み込みが deadline を共有し、合計でも制限時間内に応答する", async () => {
    // 1 段目が制限時間のほとんどを使い切ると、2 段目は待たずに degrade する
    const FIRST_STAGE_MS = AUTOCOMPLETE_TIMEOUT_MS - 200;
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockResolvedValue(null),
        getInstallationRepositories: vi.fn().mockImplementation(() => after(FIRST_STAGE_MS, installationRepositories)),
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(null),
        getRepositoryIndex: vi.fn().mockImplementation(() => never<RepositoryIndex>()),
      },
    } as unknown as DiscordDependencies;

    const startedAt = Date.now();
    const res = await handleRepoAddAutocomplete(createContext(), "", deps);
    const elapsed = Date.now() - startedAt;

    // 段ごとに独立した制限時間を持つと 2 段合計で 3 秒近くになる
    expect(elapsed).toBeLessThan(RESPONSE_DEADLINE_MS);
    expectLoadingChoice(res);
    expect(waitUntilPromises).toHaveLength(1);
  });

  it("1 段目が制限時間を超えたら読み込み中候補を返し、2 段目は起動しない", async () => {
    const getIndexCache = vi.fn();
    const getRepositoryIndex = vi.fn();
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockResolvedValue(null),
        getInstallationRepositories: vi.fn().mockImplementation(() => never<CachedInstallationRepositoryList>()),
        getCachedRepositoryIndex: getIndexCache,
        getRepositoryIndex,
      },
    } as unknown as DiscordDependencies;

    const res = await handleRepoAddAutocomplete(createContext(), "", deps);

    expectLoadingChoice(res);
    // 1 段目で degrade した時点で応答するため、2 段目の cache 読み出しも KV の全件 list も行わない
    expect(getIndexCache).not.toHaveBeenCalled();
    expect(getRepositoryIndex).not.toHaveBeenCalled();
    expect(waitUntilPromises).toHaveLength(1);
  });

  it("installation 一覧の cache 読み出しが制限時間を超えたら待たずに読み込み中を返し、本体の読み込みで温める", async () => {
    const getInstallationRepositories = vi.fn().mockResolvedValue(installationRepositories);
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockImplementation(() => never<null>()),
        getInstallationRepositories,
        getCachedRepositoryIndex: vi.fn(),
        getRepositoryIndex: vi.fn(),
      },
    } as unknown as DiscordDependencies;

    const startedAt = Date.now();
    const res = await handleRepoAddAutocomplete(createContext(), "", deps);

    expect(Date.now() - startedAt).toBeLessThan(RESPONSE_DEADLINE_MS);
    expectLoadingChoice(res);
    expect(waitUntilPromises).toHaveLength(1);

    await Promise.all(waitUntilPromises);
    expect(getInstallationRepositories).toHaveBeenCalledTimes(1);
  });

  it("1 文字入力ごとの interaction が重なっても installation 一覧の取得は 1 本にまとめられる", async () => {
    const getInstallationRepositories = vi.fn().mockImplementation(() => after(SLOW_MS, installationRepositories));
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockResolvedValue(null),
        getInstallationRepositories,
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(null),
        getRepositoryIndex: vi.fn(),
      },
    } as unknown as DiscordDependencies;

    const first = handleRepoAddAutocomplete(createContext(), "my", deps);
    const second = handleRepoAddAutocomplete(createContext(), "myr", deps);
    for (const res of await Promise.all([first, second])) {
      expectLoadingChoice(res);
    }

    await Promise.all(waitUntilPromises);
    expect(getInstallationRepositories).toHaveBeenCalledTimes(1);
  });

  it("installation 一覧の読み込みの失敗を記録して空候補へ degrade する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // 記録内容だけを検証する
    });
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockRejectedValue(new Error("installation cache down")),
      },
    } as unknown as DiscordDependencies;

    const res = await handleRepoAddAutocomplete(createContext(), "", deps);

    expect(bodyOf(res).data.choices).toEqual([]);
    expect(error).toHaveBeenCalledWith("discord_autocomplete_failed", {
      label: "repo_add",
      error: "Error: installation cache down",
    });
  });
});
