import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleStatus } from "./status.js";
import { errors } from "../../../domain/errors.js";
import { EmbedColor } from "../interaction-response.js";

import type { MergeGateResult } from "../../../domain/merge-gate.js";
import type { RegisteredRepository } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { GitHubPullRequest } from "../../../usecase/github.js";
import type { StatusResult, StatusUsecaseParams } from "../../../usecase/status/interface.js";
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

const getStatusMock = vi.fn<(params: StatusUsecaseParams) => Promise<StatusResult>>();

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
    statusUsecase: { getStatus: getStatusMock },
  }) as unknown as DiscordDependencies;

const createInteraction = (options: { repo?: string; pr?: string }): APIChatInputApplicationCommandInteraction => {
  const dataOptions = [];
  if (options.repo !== undefined) dataOptions.push({ name: "repo", type: 3, value: options.repo });
  if (options.pr !== undefined) dataOptions.push({ name: "pr", type: 3, value: options.pr });
  return {
    data: { name: "status", type: 1, options: dataOptions },
    member: { roles: [], user: { id: "user-1", username: "alice" } },
    guild_id: "guild-1",
    token: "interaction-token",
  } as unknown as APIChatInputApplicationCommandInteraction;
};

const statusResult = (overrides: Partial<StatusResult>): StatusResult => ({
  gateResult: { canMerge: true, headSha: "abc123" },
  pr: testPr,
  repo: testRepo,
  ...overrides,
});

const runHandler = async (interaction: APIChatInputApplicationCommandInteraction): Promise<void> => {
  handleStatus(createContext(), interaction, createDeps());
  await Promise.all(waitUntilPromises);
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleStatus", () => {
  it("マージ可のとき success embed に判定、Repository、Author、Branch の順で field を出す", async () => {
    getStatusMock.mockResolvedValue(statusResult({ gateResult: { canMerge: true, headSha: "abc123" } }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed).toMatchObject({
      title: "feat: add feature (#42)",
      url: "https://github.com/org/repo/pull/42",
      fields: [
        { name: "マージ可", value: "マージ条件をすべて満たしています。" },
        { name: "Repository", value: "`org/repo`" },
        { name: "Author", value: "alice", inline: true },
        { name: "Branch", value: "`feature-branch` → `main`", inline: true },
      ],
      color: EmbedColor.Success,
    });
    expect(embed?.description).toBeUndefined();
    expect(embed?.timestamp).toEqual(expect.any(String));
  });

  it("マージ不可のとき warning embed の判定 field に原因と失敗 check の list を出す", async () => {
    const failedChecks = [
      { name: "lint", status: "completed", conclusion: "failure", htmlUrl: "https://github.com/org/repo/runs/1" },
      { name: "a`b", status: "completed", conclusion: "timed_out", htmlUrl: null },
    ];
    const gateResult: MergeGateResult = { canMerge: false, error: errors.checksFailed({ failedChecks }) };
    getStatusMock.mockResolvedValue(statusResult({ gateResult }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.color).toBe(EmbedColor.Warning);
    expect(embed?.fields?.[0]?.name).toBe("マージ不可");
    expect(embed?.fields?.[0]?.value).toBe(
      "一部の check が失敗しています。\n- 🚫 [`lint`](https://github.com/org/repo/runs/1)\n- 🚫 `a'b`"
    );
  });

  it("実行中の check は ⏳ で出す", async () => {
    const failedChecks = [{ name: "test", status: "in_progress", conclusion: null, htmlUrl: null }];
    const gateResult: MergeGateResult = { canMerge: false, error: errors.checksPending({ failedChecks }) };
    getStatusMock.mockResolvedValue(statusResult({ gateResult }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    expect(editDeferredResponseMock.mock.calls[0]?.[2]?.fields?.[0]?.value).toBe(
      "一部の check がまだ実行中です。\n- ⏳ `test`"
    );
  });

  it("失敗した status は 🚫 で出し、安全でない URL はリンクにしない", async () => {
    const failedStatuses = [{ context: "ci", state: "failure", targetUrl: "javascript:alert(1)" }];
    const gateResult: MergeGateResult = {
      canMerge: false,
      error: errors.statusesFailed({ state: "failure", failedStatuses }),
    };
    getStatusMock.mockResolvedValue(statusResult({ gateResult }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    expect(editDeferredResponseMock.mock.calls[0]?.[2]?.fields?.[0]?.value).toMatch(/\n- 🚫 `ci`$/);
  });

  it("status は名前を inline code にして詳細ページへリンクする", async () => {
    const failedStatuses = [{ context: "ci", state: "pending", targetUrl: "https://ci.example.com/1" }];
    const gateResult: MergeGateResult = {
      canMerge: false,
      error: errors.statusesPending({ state: "pending", failedStatuses }),
    };
    getStatusMock.mockResolvedValue(statusResult({ gateResult }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    expect(editDeferredResponseMock.mock.calls[0]?.[2]?.fields?.[0]?.value).toBe(
      "一部の status check がまだ完了していません。\n- ⏳ [`ci`](https://ci.example.com/1)"
    );
  });

  it("不足している必須 check を 🚫 と原因付きで出す", async () => {
    const requiredChecks = [
      { context: "build", integrationId: 15368, reason: "missing" },
      { context: "test", integrationId: null, reason: "source_mismatch" },
    ];
    const gateResult: MergeGateResult = { canMerge: false, error: errors.requiredChecksMissing({ requiredChecks }) };
    getStatusMock.mockResolvedValue(statusResult({ gateResult }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    expect(editDeferredResponseMock.mock.calls[0]?.[2]?.fields?.[0]?.value).toBe(
      "必須の check が未実行か、期待する GitHub App 以外から報告されています。\n- 🚫 `build`（未実行）\n- 🚫 `test`（報告元が異なる）"
    );
  });

  it("title の markdown を escape する", async () => {
    getStatusMock.mockResolvedValue(statusResult({ pr: { ...testPr, title: "fix *bold* `code`" } }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    expect(editDeferredResponseMock.mock.calls[0]?.[2]?.title).toBe("fix \\*bold\\* \\`code\\` (#42)");
  });

  it("title は PR 番号を残して 256 文字に切り詰め、branch 名の ` は置き換えて inline code にする", async () => {
    const pr = { ...testPr, title: "a".repeat(256), head: { sha: "abc123", ref: "x`y" } };
    getStatusMock.mockResolvedValue(statusResult({ pr }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    const embed = editDeferredResponseMock.mock.calls[0]?.[2];
    expect(embed?.title).toHaveLength(256);
    expect(embed?.title?.endsWith("… (#42)")).toBe(true);
    expect(embed?.fields?.[3]?.value).toBe("`x'y` → `main`");
  });

  it("判定 field が 1024 文字を超える分の check は「…ほか N 件」にまとめる", async () => {
    const failedChecks = Array.from({ length: 100 }, (_, i) => ({
      name: `check-${String(i + 1)}`,
      status: "completed",
      conclusion: "failure",
      htmlUrl: null,
    }));
    const gateResult: MergeGateResult = { canMerge: false, error: errors.checksFailed({ failedChecks }) };
    getStatusMock.mockResolvedValue(statusResult({ gateResult }));

    await runHandler(createInteraction({ repo: "repo-1", pr: "42" }));

    const value = editDeferredResponseMock.mock.calls[0]?.[2]?.fields?.[0]?.value ?? "";
    const listed = value.match(/^- 🚫 `check-/gm)?.length ?? 0;
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(listed).toBeGreaterThan(0);
    expect(value.endsWith(`\n- …ほか ${String(100 - listed)} 件`)).toBe(true);
  });

  it.each(["0x10", "5e2", " 5 ", "0", "-1"])("PR 番号 %s は無効として usecase を呼ばずエラーを返す", async (pr) => {
    await runHandler(createInteraction({ repo: "repo-1", pr }));

    expect(getStatusMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith("app-id", "interaction-token", "PR 番号が無効です。");
  });

  it("PR 番号が空文字のとき usecase を呼ばず未指定エラーを返す", async () => {
    await runHandler(createInteraction({ repo: "repo-1", pr: "" }));

    expect(getStatusMock).not.toHaveBeenCalled();
    expect(editDeferredWithErrorMock).toHaveBeenCalledWith("app-id", "interaction-token", "pr が指定されていません。");
  });

  it("正常な PR 番号 5 のとき usecase を prNumber:5 で呼ぶ", async () => {
    getStatusMock.mockResolvedValue(statusResult({}));

    await runHandler(createInteraction({ repo: "repo-1", pr: "5" }));

    expect(getStatusMock).toHaveBeenCalledWith(expect.objectContaining({ repoId: "repo-1", prNumber: 5 }));
  });
});
