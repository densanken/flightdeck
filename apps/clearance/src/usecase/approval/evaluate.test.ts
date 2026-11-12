import { createLogger } from "@flightdeck/logger";
import { describe, expect, it, vi } from "vitest";

import { decide, evaluate } from "./evaluate.js";
import { ApiError, BudgetExceeded } from "../../errors.js";

import type { ApprovalGateway, PullRequest } from "./dependencies.js";

const settings = { dispatchId: 1, renovateIds: [2], botUserId: 3 };
const now = Date.parse("2026-11-10T00:00:00Z");
const pr: PullRequest = {
  state: "OPEN",
  draft: false,
  body: "**Automerge**: Disabled by config.",
  createdAt: "2026-09-01T00:00:00Z",
  branch: "flightdeck-dispatch/org/source",
  headSha: "new",
  mergeSha: null,
  baseBranch: "main",
  baseOid: "base",
  author: { type: "Bot", id: 1 },
  editor: null,
  lastEditedAt: null,
  headRepositoryId: 1,
  labels: [],
  files: [{ path: "sub", changeType: "MODIFIED" }],
  opinionatedReviews: [],
  reviews: [],
  timeline: [],
  timelinePageCount: 0,
  timelineHasPreviousPage: false,
  recentCount: 0,
  submodules: [{ path: "sub", gitUrl: "https://github.com/org/source.git" }],
  submodulesComplete: true,
  checks: [],
  statuses: [],
};
const gateway = (): ApprovalGateway => ({
  authenticate: vi.fn(() => Promise.resolve()),
  associated: vi.fn(() => Promise.resolve([])),
  search: vi.fn(() => Promise.resolve([])),
  pullRequest: vi.fn(() => Promise.resolve({ repositoryId: 1, pr })),
  configs: vi.fn(() => Promise.resolve([])),
  trees: vi.fn(() => Promise.resolve({ base: { type: "commit", oid: "old" }, head: { type: "commit", oid: "new" } })),
  compare: vi.fn(() => Promise.resolve({ source: "BEHIND", ancestry: "behind" })),
  rules: vi.fn(() => Promise.resolve([])),
  approve: vi.fn(() => Promise.resolve({ status: 200, reviewId: 9 })),
  dismiss: vi.fn(() => Promise.resolve({ status: 200 })),
  reviewState: vi.fn(() => Promise.resolve("APPROVED")),
  subrequests: () => 0,
});
const logger = createLogger("error", { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("PR の承認条件", () => {
  it.each([
    ["closed", { state: "CLOSED" }],
    ["対象外 author", { author: { type: "User", id: 10 } }],
  ])("%s の PR は設定を取得しない", async (_name, change) => {
    const client = gateway();

    expect((await decide(client, 1, { ...pr, ...change }, settings, now)).kind).toBe("skip");
    expect(client.configs).not.toHaveBeenCalled();
  });

  it("dispatch の gitlink を CI の完了前に承認する", async () => {
    expect(await decide(gateway(), 1, pr, settings, now)).toEqual({
      kind: "allowed",
      policy: "dispatch",
      headSha: "new",
    });
  });

  it("不正な base 設定で停止し Renovate の opt-out を適用する", async () => {
    const client = gateway();
    vi.mocked(client.configs).mockResolvedValueOnce([
      { path: ".github/flightdeck.yml", text: "autopilot: {unknown: true}" },
    ]);

    expect(await decide(client, 1, pr, settings, now)).toMatchObject({
      kind: "undeterminable",
      reasonCode: "config_invalid",
    });

    vi.mocked(client.configs).mockResolvedValueOnce([
      { path: ".github/flightdeck.yaml", text: "autopilot: {renovate-stale: false}" },
    ]);

    expect(
      await decide(
        client,
        1,
        {
          ...pr,
          author: { type: "Bot", id: 2 },
        },
        settings,
        now
      )
    ).toMatchObject({
      kind: "violated",
      reasonCode: "renovate_disabled",
    });
  });

  it("共通ガードと dispatch の違反を拒否する", async () => {
    for (const change of [
      { draft: true },
      { headRepositoryId: 2 },
      { labels: ["AUTOPILOT:SKIP"] },
      { branch: "other" },
      { files: [...pr.files, { path: "extra", changeType: "MODIFIED" }] },
      { files: [{ path: ".github/flightdeck.yaml", changeType: "MODIFIED" }] },
      { opinionatedReviews: [{ id: 4, state: "CHANGES_REQUESTED", author: { type: "User", id: 4 }, commitOid: null }] },
    ]) {
      expect((await decide(gateway(), 1, { ...pr, ...change }, settings, now)).kind).toBe("violated");
    }
  });

  it("Renovate には人間操作の放置期間と CI 成功を要求する", async () => {
    const renovate = {
      ...pr,
      author: { type: "Bot", id: 2 },
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
    };

    expect((await decide(gateway(), 1, renovate, settings, now)).kind).toBe("allowed");
    expect((await decide(gateway(), 1, { ...renovate, createdAt: "2026-11-01T00:00:00Z" }, settings, now)).kind).toBe(
      "violated"
    );
    expect((await decide(gateway(), 1, { ...renovate, body: "**Automerge**: Enabled." }, settings, now)).kind).toBe(
      "violated"
    );
    expect((await decide(gateway(), 1, { ...renovate, checks: [] }, settings, now)).kind).toBe("undeterminable");
    expect(
      (
        await decide(
          gateway(),
          1,
          {
            ...renovate,
            checks: [
              { name: "ci", status: "completed", conclusion: "failure", app: { id: 5, slug: "github-actions" } },
            ],
          },
          settings,
          now
        )
      ).kind
    ).toBe("violated");
  });

  it("条件違反では古い承認を撤回し API エラーでは維持する", async () => {
    const client = gateway();
    const approved = {
      ...pr,
      draft: true,
      reviews: [{ id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" }],
    };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: approved });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "draft");

    vi.mocked(client.dismiss).mockClear();
    vi.mocked(client.pullRequest).mockRejectedValue(new Error("unavailable"));

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).not.toHaveBeenCalled();
  });
});

describe("レビューの状態遷移", () => {
  it("未取得の timeline があり取得ページがすべて直近なら承認を撤回する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: {
        ...pr,
        author: { type: "Bot", id: 2 },
        reviews: [review],
        timeline: Array.from({ length: 100 }, () => ({ kind: "other" as const })),
        timelinePageCount: 100,
        timelineHasPreviousPage: true,
        recentCount: 100,
      },
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "human_activity");
    expect(client.approve).not.toHaveBeenCalled();
  });

  it("submodule 一覧が不完全なら承認を維持する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: { ...pr, reviews: [review], submodulesComplete: false },
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
  });

  it("有効な承認は再投稿せず古い SHA は再評価して承認する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "new" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [review] } });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.approve).not.toHaveBeenCalled();

    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: { ...pr, reviews: [{ ...review, commitOid: "old" }] },
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.approve).toHaveBeenCalledWith(1, "new");
  });

  it.each([
    ["CI の結果による dispatch PR", { commitSha: "new" }],
    ["Dismiss だけを行う評価", { dismissOnly: true }],
  ])("%s では承認せず、違反なら撤回する", async (_name, trigger) => {
    const client = gateway();
    const options = { fields: {}, expectedRepositoryId: 1, clock: () => now, ...trigger };

    await evaluate(client, 1, settings, logger, options);

    expect(client.approve).not.toHaveBeenCalled();

    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "new" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, draft: true, reviews: [review] } });

    await evaluate(client, 1, settings, logger, options);

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "draft");
  });

  it("撤回拒否を記録し再試行しない", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, draft: true, reviews: [review] } });
    vi.mocked(client.dismiss).mockRejectedValue(new ApiError(403));
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: {},
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(client.dismiss).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"action":"dismiss_failed"'));
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"api_status":403'));
  });

  it.each([
    ["DISMISSED", "already_dismissed", "info"],
    ["APPROVED", "dismiss_failed", "warn"],
  ] as const)("撤回が 422 でレビューが %s なら %s を記録する", async (state, action, level) => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, draft: true, reviews: [review] } });
    vi.mocked(client.dismiss).mockRejectedValue(new ApiError(422));
    vi.mocked(client.reviewState).mockResolvedValue(state);
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: {},
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(client.reviewState).toHaveBeenCalledWith(1, 7);
    expect(sink[level]).toHaveBeenCalledWith(expect.stringContaining(`"action":"${action}"`));
  });

  it("closed、対象外 author、SHA 不一致では操作しない", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "new" };

    for (const change of [{ state: "CLOSED" }, { author: { type: "User", id: 99 } }]) {
      vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, ...change, reviews: [review] } });
      await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });
    }

    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr });

    await evaluate(client, 1, settings, logger, {
      fields: {},
      commitSha: "other",
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it("repository ID が不一致なら設定を取得せずレビューを操作しない", async () => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 2, pr });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.configs).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it("GitHub Actions がなくても確定した CI 失敗で撤回する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "new" };
    const renovate = {
      ...pr,
      author: { type: "Bot", id: 2 },
      reviews: [review],
      statuses: [{ context: "external", state: "failure" }],
    };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: renovate });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "ci_failed");
  });

  it("CI がない、pending、比較不能の場合は承認を維持する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "new" };
    const renovate = { ...pr, author: { type: "Bot", id: 2 }, reviews: [review] };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: renovate });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: {
        ...renovate,
        checks: [{ name: "ci", status: "queued", conclusion: null, app: { id: 5, slug: "github-actions" } }],
      },
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [review] } });
    vi.mocked(client.compare).mockRejectedValue(new Error("not found"));

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
  });
});

describe("設定ファイルの改名", () => {
  it.each(["RENAMED", "COPIED"])("base に設定がなくても %s を保留する", async (changeType) => {
    const client = gateway();
    const renamed = {
      ...pr,
      author: { type: "Bot", id: 2 },
      files: [{ path: "renamed.yml", changeType }],
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
    };
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...renamed, reviews: [review] } });

    expect(await decide(client, 1, renamed, settings, now)).toMatchObject({
      kind: "undeterminable",
      reasonCode: "config_rename_unknown",
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it("改名元が不明でも確定した違反を優先する", async () => {
    const client = gateway();
    const renamed = {
      ...pr,
      author: { type: "Bot", id: 2 },
      files: [{ path: "other.yml", changeType: "RENAMED" }],
      checks: [{ name: "ci", status: "completed", conclusion: "failure", app: { id: 5, slug: "github-actions" } }],
    };

    expect(await decide(client, 1, { ...renamed, headRepositoryId: 2 }, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "fork",
    });
    expect(await decide(client, 1, renamed, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "ci_failed",
    });
    expect(client.rules).not.toHaveBeenCalled();
  });
});

describe("submodule と評価ログ", () => {
  it("dispatch にだけ完全な submodule 一覧を要求する", async () => {
    const client = gateway();

    expect(await decide(client, 1, { ...pr, submodulesComplete: false }, settings, now)).toMatchObject({
      kind: "undeterminable",
      reasonCode: "submodules_truncated",
    });

    const renovate = {
      ...pr,
      submodulesComplete: false,
      author: { type: "Bot", id: 2 },
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
    };

    expect((await decide(client, 1, renovate, settings, now)).kind).toBe("allowed");
  });

  it("source 履歴の不一致や設定変更で撤回する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [review] } });
    vi.mocked(client.compare).mockResolvedValue({ source: "AHEAD", ancestry: "behind" });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "invalid_source_history");

    for (const path of [".gitmodules", ".github/flightdeck.yml", ".github/flightdeck.yaml"]) {
      expect((await decide(client, 1, { ...pr, files: [{ path, changeType: "MODIFIED" }] }, settings, now)).kind).toBe(
        "violated"
      );
    }
  });

  it("違反と判定不能でも policy と head SHA を記録する", async () => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, draft: true } });

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: {},
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"policy":"dispatch"'));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"head_sha":"new"'));

    vi.mocked(client.compare).mockRejectedValue(new Error("API error"));
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr });

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: {},
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"policy":"dispatch"'));
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"head_sha":"new"'));
  });
});

describe("設定によるレビュー操作", () => {
  it("設定の取得に失敗したら承認も撤回もしない", async () => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: { ...pr, reviews: [{ id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" }] },
    });
    vi.mocked(client.configs).mockRejectedValue(new Error("unavailable"));

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.configs).toHaveBeenCalledWith("base");
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it("skip と opt-out で撤回し設定エラーでは維持する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "new" };
    const renovate = { ...pr, author: { type: "Bot", id: 2 }, reviews: [review] };
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: { ...renovate, labels: ["autopilot:skip"] },
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "opted_out");

    vi.mocked(client.dismiss).mockClear();
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: renovate });
    vi.mocked(client.configs).mockResolvedValue([
      { path: ".github/flightdeck.yaml", text: "autopilot: {renovate-stale: false}" },
    ]);

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "renovate_disabled");

    vi.mocked(client.dismiss).mockClear();
    vi.mocked(client.configs).mockResolvedValue([
      { path: ".github/flightdeck.yml", text: "" },
      { path: ".github/flightdeck.yaml", text: "" },
    ]);

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
  });
});

describe("gitlink と head の評価", () => {
  it.each(["base", "head"] as const)("取得した %s の tree に gitlink がなければ撤回する", async (missing) => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [review] } });
    vi.mocked(client.trees).mockResolvedValue({
      base: missing === "base" ? null : { type: "commit", oid: "old" },
      head: missing === "head" ? null : { type: "commit", oid: "new" },
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "invalid_gitlink");
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.compare).not.toHaveBeenCalled();
  });

  it("tree を取得できない場合は承認を維持する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [review] } });
    vi.mocked(client.trees).mockRejectedValue(new Error("tree unavailable"));

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
  });

  it("head 変更後も再取得せず評価済み SHA を承認する", async () => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValueOnce({ repositoryId: 1, pr });
    vi.mocked(client.compare).mockImplementation(() => {
      vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, headSha: "later-head" } });
      return Promise.resolve({ source: "BEHIND", ancestry: "behind" });
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.pullRequest).toHaveBeenCalledTimes(1);
    expect(client.approve).toHaveBeenCalledWith(1, "new");
  });

  it("新しい head に通常ファイルを追加したら古い承認を撤回する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old-head" };
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: {
        ...pr,
        headSha: "new-head",
        reviews: [review],
        files: [...pr.files, { path: "other.txt", changeType: "ADDED" }],
      },
    });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "invalid_diff");
    expect(client.approve).not.toHaveBeenCalled();
  });
});

describe("必須 CI の source", () => {
  it("必須 source の一致時は承認し不一致時は撤回する", async () => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    const renovate: PullRequest = {
      ...pr,
      author: { type: "Bot", id: 2 },
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
      reviews: [review],
    };
    vi.mocked(client.rules).mockResolvedValue([{ context: "ci", integrationId: 5 }]);
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: renovate });

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.approve).toHaveBeenCalledWith(1, "new");

    vi.mocked(client.approve).mockClear();
    vi.mocked(client.rules).mockResolvedValue([{ context: "ci", integrationId: 6 }]);

    await evaluate(client, 1, settings, logger, { fields: {}, expectedRepositoryId: 1, clock: () => now });

    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "ci_failed");
    expect(client.approve).not.toHaveBeenCalled();
  });
});

describe("評価ログ", () => {
  it.each([
    [
      "approve の失敗",
      "approve",
      new Error("secret"),
      { decision: "allowed", action: "approve_failed", review_id: null, error_reason_code: "api_error" },
    ],
    [
      "approve の予算超過",
      "approve",
      new BudgetExceeded(),
      { decision: "undeterminable", reason_code: "subrequest_limit", action: "approve_failed", review_id: null },
    ],
    [
      "dismiss の拒否",
      "dismiss",
      new ApiError(403),
      { decision: "violated", reason_code: "draft", action: "dismiss_failed", review_id: 7, api_status: 403 },
    ],
  ])("%s でも判定と操作の状態を記録する", async (_name, operation, error, expected) => {
    const client = gateway();
    const review = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: { ...pr, draft: operation === "dismiss", reviews: operation === "dismiss" ? [review] : [] },
      queryCost: 42,
    });

    if (operation === "dismiss") vi.mocked(client.dismiss).mockRejectedValue(error);
    else vi.mocked(client.approve).mockRejectedValue(error);

    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn<(message: string) => void>(), error: vi.fn() };

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: { delivery_id: "d" },
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(sink.warn).toHaveBeenCalledOnce();

    const record = JSON.parse(vi.mocked(sink.warn).mock.calls[0]?.[0] ?? "{}") as unknown;

    expect(record).toEqual({
      event: "evaluation",
      delivery_id: "d",
      pr_number: 1,
      policy: "dispatch",
      head_sha: "new",
      graphql_cost: 42,
      duration_ms: 0,
      subrequests: 0,
      level: "warn",
      message: "evaluation",
      error_reason_code: error instanceof BudgetExceeded ? "subrequest_limit" : "api_error",
      error_name: error instanceof BudgetExceeded ? "BudgetExceeded" : error instanceof ApiError ? "ApiError" : "Error",
      error_message:
        error instanceof BudgetExceeded
          ? "subrequest limit exceeded"
          : error instanceof ApiError
            ? "GitHub request failed"
            : "GitHub request or review operation failed",
      ...expected,
    });
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("撤回済みのレビューがあっても再承認で作成したレビューの ID を記録する", async () => {
    const client = gateway();
    const review = { id: 7, state: "DISMISSED", author: { type: "Bot", id: 3 }, commitOid: "old" };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [review] } });

    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: {},
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"action":"approved","review_id":9'));
  });

  it.each(["PR の取得", "設定の取得"])("%s の失敗を記録する", async (step) => {
    const client = gateway();

    if (step === "PR の取得") vi.mocked(client.pullRequest).mockRejectedValue(new Error("secret"));
    else {
      vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr, queryCost: 42 });
      vi.mocked(client.configs).mockRejectedValue(new Error("secret"));
    }

    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn<(message: string) => void>(), error: vi.fn() };

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: { delivery_id: "d" },
      expectedRepositoryId: 1,
      clock: () => now,
    });

    const record = JSON.parse(vi.mocked(sink.warn).mock.calls[0]?.[0] ?? "{}") as unknown;

    expect(record).toEqual({
      event: "evaluation",
      delivery_id: "d",
      pr_number: 1,
      decision: "undeterminable",
      reason_code: "api_error",
      action: "none",
      review_id: null,
      error_reason_code: "api_error",
      error_name: "Error",
      error_message: "GitHub request or review operation failed",
      subrequests: 0,
      duration_ms: 0,
      level: "warn",
      message: "evaluation",
      policy: step === "設定の取得" ? "dispatch" : undefined,
      head_sha: step === "設定の取得" ? "new" : undefined,
      graphql_cost: step === "設定の取得" ? 42 : undefined,
    });
  });

  it("PR の取得で予算が尽きたら subrequest_limit として保留する", async () => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.mocked(client.pullRequest).mockRejectedValue(new BudgetExceeded());

    await evaluate(client, 1, settings, createLogger("info", sink), {
      fields: {},
      expectedRepositoryId: 1,
      clock: () => now,
    });

    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"subrequest_limit"'));
  });
});
