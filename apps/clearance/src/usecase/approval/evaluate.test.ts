import { decide, errorDetails } from "@flightdeck/github-policy";
import { createLogger } from "@flightdeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { evaluate } from "./evaluate.js";

import type { ApprovalGateway } from "./dependencies.js";
import type { PolicyPullRequest } from "@flightdeck/rules";

vi.mock("@flightdeck/github-policy", () => ({ decide: vi.fn(), errorDetails: vi.fn() }));

const settings = { dispatchId: 1, renovateIds: [2], botUserId: 3 };
const now = Date.parse("2026-11-10T00:00:00Z");
const pr: PolicyPullRequest = {
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

beforeEach(() => {
  vi.mocked(decide).mockReset();
  vi.mocked(errorDetails).mockReset();
  vi.mocked(errorDetails).mockReturnValue({
    reasonCode: "api_error",
    errorName: "Error",
    errorMessage: "GitHub request or review operation failed",
    apiStatus: undefined,
  });
  vi.mocked(decide).mockResolvedValue({ kind: "allowed", policy: "dispatch", headSha: "new" });
});

const approved = { id: 7, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" };
const options = { fields: {}, expectedRepositoryId: 1, clock: () => now };

describe("判定結果によるレビュー操作", () => {
  it("許可された head を承認し判定に取得した値を渡す", async () => {
    const client = gateway();
    await evaluate(client, 1, settings, logger, options);
    expect(decide).toHaveBeenCalledWith(client, 1, pr, settings, now);
    expect(client.approve).toHaveBeenCalledWith(1, "new");
  });

  it("現在の head の承認は再投稿せず古い承認は更新する", async () => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: { ...pr, reviews: [{ ...approved, commitOid: "new" }] },
    });
    await evaluate(client, 1, settings, logger, options);
    expect(client.approve).not.toHaveBeenCalled();

    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [approved] } });
    await evaluate(client, 1, settings, logger, options);
    expect(client.approve).toHaveBeenCalledWith(1, "new");
  });

  it("違反では古い承認を理由付きで撤回する", async () => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [approved] } });
    vi.mocked(decide).mockResolvedValue({ kind: "violated", reasonCode: "invalid_diff" });
    await evaluate(client, 1, settings, logger, options);
    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "invalid_diff");
    expect(client.approve).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "skip", reasonCode: "unknown_author" },
    { kind: "undeterminable", reasonCode: "config_rename_unknown" },
    { kind: "undeterminable", reasonCode: "submodules_truncated" },
    { kind: "undeterminable", reasonCode: "ci_pending" },
  ] as const)("判定が $kind の場合は承認も撤回もしない", async (decision) => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [approved] } });
    vi.mocked(decide).mockResolvedValue(decision);
    await evaluate(client, 1, settings, logger, options);
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it.each([
    ["CI の結果による dispatch PR", { commitSha: "new" }],
    ["Dismiss だけを行う評価", { dismissOnly: true }],
  ])("%s は許可されても承認せず違反なら撤回する", async (_name, trigger) => {
    const client = gateway();
    await evaluate(client, 1, settings, logger, { ...options, ...trigger });
    expect(client.approve).not.toHaveBeenCalled();

    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [approved] } });
    vi.mocked(decide).mockResolvedValue({ kind: "violated", reasonCode: "draft" });
    await evaluate(client, 1, settings, logger, { ...options, ...trigger });
    expect(client.dismiss).toHaveBeenCalledWith(1, 7, "draft");
  });

  it("SHA または repository が不一致なら共通判定せず操作を行わない", async () => {
    const client = gateway();
    await evaluate(client, 1, settings, logger, { ...options, commitSha: "other" });
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 2, pr });
    await evaluate(client, 1, settings, logger, options);
    expect(decide).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it("検証後に head が変わっても再取得せず評価済み SHA を承認する", async () => {
    const client = gateway();
    vi.mocked(decide).mockImplementationOnce(() => {
      vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, headSha: "later-head" } });
      return Promise.resolve({ kind: "allowed", policy: "dispatch", headSha: "new" });
    });
    await evaluate(client, 1, settings, logger, options);
    expect(client.pullRequest).toHaveBeenCalledTimes(1);
    expect(client.approve).toHaveBeenCalledWith(1, "new");
  });

  it.each([
    ["DISMISSED", "already_dismissed", "info"],
    ["APPROVED", "dismiss_failed", "warn"],
  ] as const)("撤回が 422 でレビューが %s なら %s を記録する", async (state, action, level) => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [approved] } });
    vi.mocked(decide).mockResolvedValue({ kind: "violated", reasonCode: "draft" });
    vi.mocked(client.dismiss).mockRejectedValue(new Error("unavailable"));
    vi.mocked(errorDetails).mockReturnValue({
      reasonCode: "api_error",
      errorName: "ApiError",
      errorMessage: "GitHub request failed",
      apiStatus: 422,
    });
    vi.mocked(client.reviewState).mockResolvedValue(state);
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await evaluate(client, 1, settings, createLogger("info", sink), options);
    expect(client.reviewState).toHaveBeenCalledWith(1, 7);
    expect(sink[level]).toHaveBeenCalledWith(expect.stringContaining(`"action":"${action}"`));
  });

  it("撤回拒否は記録し再試行しない", async () => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, reviews: [approved] } });
    vi.mocked(decide).mockResolvedValue({ kind: "violated", reasonCode: "draft" });
    vi.mocked(client.dismiss).mockRejectedValue(new Error("unavailable"));
    vi.mocked(errorDetails).mockReturnValue({
      reasonCode: "api_error",
      errorName: "ApiError",
      errorMessage: "GitHub request failed",
      apiStatus: 403,
    });
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await evaluate(client, 1, settings, createLogger("info", sink), options);
    expect(client.dismiss).toHaveBeenCalledOnce();
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"api_status":403'));
  });
});

describe("評価ログ", () => {
  it.each([
    { decision: { kind: "violated", reasonCode: "draft" }, level: "info" },
    { decision: { kind: "undeterminable", reasonCode: "config_invalid" }, level: "warn" },
  ] as const)("判定が $decision.kind でも policy と head を記録する", async ({ decision, level }) => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.mocked(decide).mockResolvedValue(decision);
    await evaluate(client, 1, settings, createLogger("info", sink), options);
    expect(sink[level]).toHaveBeenCalledWith(expect.stringContaining('"policy":"dispatch"'));
    expect(sink[level]).toHaveBeenCalledWith(expect.stringContaining('"head_sha":"new"'));
    expect(sink[level]).toHaveBeenCalledWith(expect.stringContaining(`"reason_code":"${decision.reasonCode}"`));
  });

  it.each(["PR の取得", "共通判定"])("%s の失敗時は安全なログを残して操作しない", async (step) => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    if (step === "PR の取得") vi.mocked(client.pullRequest).mockRejectedValue(new Error("secret"));
    else vi.mocked(decide).mockRejectedValue(new Error("secret"));
    await evaluate(client, 1, settings, createLogger("info", sink), options);
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"api_error"'));
    expect(sink.warn.mock.calls[0]?.[0]).not.toContain("secret");
  });

  it("承認失敗時に判定、レビュー操作と安全なエラーを記録する", async () => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn<(message: string) => void>(), error: vi.fn() };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr, queryCost: 42 });
    vi.mocked(client.approve).mockRejectedValue(new Error("secret"));
    await evaluate(client, 1, settings, createLogger("info", sink), { ...options, fields: { delivery_id: "d" } });
    const record = JSON.parse(sink.warn.mock.calls[0]?.[0] ?? "{}") as unknown;
    expect(record).toMatchObject({
      event: "evaluation",
      delivery_id: "d",
      pr_number: 1,
      decision: "allowed",
      action: "approve_failed",
      review_id: null,
      policy: "dispatch",
      head_sha: "new",
      graphql_cost: 42,
      error_reason_code: "api_error",
      error_name: "Error",
      error_message: "GitHub request or review operation failed",
    });
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("承認時の subrequest 上限超過は判定不能として記録する", async () => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.mocked(client.approve).mockRejectedValue(new Error("unavailable"));
    vi.mocked(errorDetails).mockReturnValue({
      reasonCode: "subrequest_limit",
      errorName: "SubrequestLimitExceeded",
      errorMessage: "subrequest limit exceeded",
      apiStatus: undefined,
    });
    await evaluate(client, 1, settings, createLogger("info", sink), options);
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"subrequest_limit"'));
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"action":"approve_failed"'));
  });

  it("承認後に新しいレビュー ID を記録する", async () => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.mocked(client.pullRequest).mockResolvedValue({
      repositoryId: 1,
      pr: { ...pr, reviews: [{ ...approved, state: "DISMISSED" }] },
    });
    await evaluate(client, 1, settings, createLogger("info", sink), options);
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"action":"approved","review_id":9'));
  });
});
