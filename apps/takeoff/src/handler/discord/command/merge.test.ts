import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMerge } from "./merge.js";
import { EmbedColor } from "../interaction-response.js";

import type { RegisteredRepository } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { ApprovedRun } from "../../../usecase/auto-approve/interface.js";
import type { GitHubPullRequest } from "../../../usecase/github.js";
import type { MergeResult, MergeUsecaseParams } from "../../../usecase/merge/interface.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { APIChatInputApplicationCommandInteraction, APIEmbed } from "discord-api-types/v10";
import type { Context } from "hono";

const editDeferredResponseMock = vi.fn<(applicationId: string, token: string, embed: APIEmbed) => Promise<void>>();
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

const testRepo: RegisteredRepository = {
  repoId: "repo-1",
  owner: "org",
  name: "repo",
  fullName: "org/repo",
  htmlUrl: "https://github.com/org/repo",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const testPr: GitHubPullRequest = {
  number: 42,
  title: "feat: add feature",
  html_url: "https://github.com/org/repo/pull/42",
  state: "open",
  draft: false,
  mergeable: true,
  head: { sha: "abc123", ref: "feature-branch" },
  base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
  user: { login: "alice" },
  updated_at: "2024-01-01T00:00:00Z",
};

const mergeMock = vi.fn<(params: MergeUsecaseParams) => Promise<MergeResult>>();
const afterMergeMock = vi.fn<() => Promise<void>>();

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
    mergeUsecase: { merge: mergeMock },
  }) as unknown as DiscordDependencies;

const createInteraction = (options: { repo?: string; pr?: string }): APIChatInputApplicationCommandInteraction => {
  const dataOptions = [];
  if (options.repo !== undefined) dataOptions.push({ name: "repo", type: 3, value: options.repo });
  if (options.pr !== undefined) dataOptions.push({ name: "pr", type: 3, value: options.pr });
  return {
    data: { name: "merge", type: 1, options: dataOptions },
    member: { roles: [], user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  } as unknown as APIChatInputApplicationCommandInteraction;
};

const runHandler = async (interaction: APIChatInputApplicationCommandInteraction): Promise<void> => {
  handleMerge(createContext(), interaction, createDeps());
  await Promise.all(waitUntilPromises);
};

beforeEach(() => {
  vi.clearAllMocks();
  afterMergeMock.mockResolvedValue(undefined);
  editDeferredResponseMock.mockResolvedValue(undefined);
  waitUntilPromises = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleMerge", () => {
  it("成功 followup の完了まで後処理を開始しない", async () => {
    let finishFollowup: () => void = vi.fn();
    editDeferredResponseMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFollowup = resolve;
        })
    );
    mergeMock.mockResolvedValue({
      type: "merged",
      sha: "sha",
      pr: testPr,
      repo: testRepo,
      mergedAt: new Date(),
      afterMerge: afterMergeMock,
    });

    handleMerge(createContext(), createInteraction({ repo: "repo-1", pr: "42" }), createDeps());
    await vi.waitFor(() => {
      expect(editDeferredResponseMock).toHaveBeenCalledOnce();
    });
    expect(afterMergeMock).not.toHaveBeenCalled();
    finishFollowup();
    await Promise.all(waitUntilPromises);
    expect(afterMergeMock).toHaveBeenCalledOnce();
  });

  it("merged 結果のとき成功 embed を出す", async () => {
    mergeMock.mockResolvedValue({
      type: "merged",
      sha: "merge-sha-123456789",
      pr: testPr,
      repo: testRepo,
      mergedAt: new Date(),
      afterMerge: afterMergeMock,
    });

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    expect(editDeferredResponseMock).toHaveBeenCalledOnce();
    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.title).toBe("PR をマージしました");
    expect(embed?.color).toBe(EmbedColor.Success);
    expect(embed?.fields).toEqual([
      { name: "Repository", value: "`org/repo`" },
      { name: "PR", value: "[feat: add feature (#42)](https://github.com/org/repo/pull/42)" },
      { name: "Branch", value: "`feature-branch` → `main`", inline: true },
      { name: "Merge commit", value: "`merge-s`", inline: true },
    ]);
    expect(editDeferredWithErrorMock).not.toHaveBeenCalled();
    expect(afterMergeMock).toHaveBeenCalledOnce();
    expect(editDeferredResponseMock.mock.invocationCallOrder[0]).toBeLessThan(
      afterMergeMock.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("auto_approved 結果のとき warning embed を出す", async () => {
    const approvedRuns: ApprovedRun[] = [{ runId: 100, name: "CI", actorLogin: "alice" }];
    mergeMock.mockResolvedValue({ type: "auto_approved", approvedRuns, pr: testPr, repo: testRepo });

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.title).toBe("Workflow run を承認しました");
    expect(embed?.color).toBe(EmbedColor.Warning);
    expect(embed?.description).toContain("承認待ちの workflow run 1 件を自動承認しました。");
    expect(embed?.fields).toEqual([
      { name: "Repository", value: "`org/repo`" },
      { name: "PR", value: "[feat: add feature (#42)](https://github.com/org/repo/pull/42)" },
    ]);
    expect(afterMergeMock).not.toHaveBeenCalled();
  });

  it("auto_approved の run 列挙は description の 4096 文字に収まる分だけ出し、残りを「…ほか N 件」にまとめる", async () => {
    const approvedRuns: ApprovedRun[] = Array.from({ length: 100 }, (_, i) => ({
      runId: i + 1,
      name: `run-${String(i + 1)}`,
      actorLogin: "alice",
    }));
    mergeMock.mockResolvedValue({ type: "auto_approved", approvedRuns, pr: testPr, repo: testRepo });

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    const description = editDeferredResponseMock.mock.calls[0]?.[2]?.description ?? "";
    const listed = description.match(/^- \[/gm)?.length ?? 0;
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(listed).toBeGreaterThan(20);
    expect(description.endsWith(`\n- …ほか ${String(100 - listed)} 件`)).toBe(true);
  });

  it("repo が未指定のとき usecase を呼ばずエラーを返す", async () => {
    await runHandler(createInteraction({ pr: "42" }));

    expect(mergeMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith(
      "app-id",
      "interaction-token",
      "repo が指定されていません。"
    );
  });

  it.each(["0x10", "5e2", " 5 ", "0", "-1", ""])("PR 番号 %s は無効として usecase を呼ばずエラーを返す", async (pr) => {
    await runHandler(createInteraction({ repo: "repo-1", pr }));

    expect(mergeMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalled();
    const message = editDeferredWithErrorMock.mock.calls[0]?.[2];
    // 空文字は「pr が指定されていません。」、それ以外は「PR 番号が無効です。」
    expect(message).toMatch(/PR 番号が無効です。|pr が指定されていません。/);
  });

  it("正常な PR 番号 5 のとき usecase を prNumber:5 で呼ぶ", async () => {
    mergeMock.mockResolvedValue({
      type: "merged",
      sha: "sha",
      pr: testPr,
      repo: testRepo,
      mergedAt: new Date(),
      afterMerge: afterMergeMock,
    });

    await runHandler(createInteraction({ repo: "repo-1", pr: "5" }));

    expect(mergeMock).toHaveBeenCalledWith(expect.objectContaining({ repoId: "repo-1", prNumber: 5 }));
    const deadline = mergeMock.mock.calls[0]?.[0].mergeDeadline ?? 0;
    expect(deadline - Date.now()).toBeGreaterThan(18_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(19_000);
  });

  it("usecase が AppError を投げたとき日本語エラーメッセージを返す", async () => {
    const { errors } = await import("../../../domain/errors.js");
    mergeMock.mockRejectedValue(errors.runsAwaitingApproval());

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    expect(editDeferredResponseMock).not.toHaveBeenCalled();
    const message = editDeferredWithErrorMock.mock.calls[0]?.[2] ?? "";
    expect(message).toContain("承認待ちの action_required workflow run");
  });
});
