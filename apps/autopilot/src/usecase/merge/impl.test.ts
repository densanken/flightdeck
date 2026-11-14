import { ciStatus, decide, errorDetails } from "@flightdeck/github-policy";
import { createLogger } from "@flightdeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MergeUseCaseImpl } from "./impl.js";

import type { MergeGateway } from "./dependencies.js";
import type { MergeInput } from "./interface.js";
import type { PolicyPullRequest } from "@flightdeck/rules";

vi.mock("@flightdeck/github-policy", () => ({ ciStatus: vi.fn(), decide: vi.fn(), errorDetails: vi.fn() }));

beforeEach(() => {
  vi.mocked(ciStatus).mockReset();
  vi.mocked(ciStatus).mockResolvedValue("passed");
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

const pr: PolicyPullRequest = {
  state: "OPEN",
  draft: false,
  body: "",
  createdAt: "2026-01-01T00:00:00Z",
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
  reviews: [{ id: 1, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "new" }],
  timeline: [],
  timelinePageCount: 0,
  timelineHasPreviousPage: false,
  recentCount: 0,
  submodules: [{ path: "sub", gitUrl: "https://github.com/org/source.git" }],
  submodulesComplete: true,
  checks: [{ name: "test", status: "completed", conclusion: "success", app: { id: 10, slug: "github-actions" } }],
  statuses: [],
};
const input: MergeInput = {
  kind: "pull_request",
  number: 4,
  deliveryId: "d",
  installationId: 1,
  repositoryId: 1,
  repository: "org/repo",
};
const setup = (value: PolicyPullRequest) => {
  const merge = vi.fn().mockResolvedValue({ merged: true, status: 200 });
  const rules = vi.fn().mockResolvedValue([]);
  const github: MergeGateway = {
    authenticate: vi.fn().mockResolvedValue(undefined),
    associated: vi.fn().mockResolvedValue([]),
    pullRequest: vi.fn().mockResolvedValue({ repositoryId: 1, pr: value }),
    configs: vi.fn().mockResolvedValue([]),
    trees: vi.fn().mockResolvedValue({ base: { type: "commit", oid: "old" }, head: { type: "commit", oid: "new" } }),
    compare: vi.fn().mockResolvedValue({ source: "BEHIND", ancestry: "behind" }),
    rules,
    merge,
    subrequests: () => 0,
  };
  const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const usecase = new MergeUseCaseImpl({
    github,
    logger: createLogger("info", sink),
    clock: () => Date.parse("2026-11-01"),
    maxSubrequests: 45,
    settings: { dispatchId: 1, renovateIds: [2], botUserId: 3 },
  });
  return { github, merge, rules, sink, usecase };
};

describe("マージの判定", () => {
  it("有効な承認と成功した CI があれば評価した SHA でマージする", async () => {
    const { github, merge, usecase } = setup(pr);
    await usecase.execute(input);
    expect(decide).toHaveBeenCalledWith(
      github,
      1,
      pr,
      { dispatchId: 1, renovateIds: [2], botUserId: 3 },
      Date.parse("2026-11-01")
    );
    expect(ciStatus).toHaveBeenCalledWith(github, pr);
    expect(merge).toHaveBeenCalledWith(4, "new");
  });

  it("Renovate の許可後は CI を再取得せずにマージする", async () => {
    vi.mocked(decide).mockResolvedValue({ kind: "allowed", policy: "renovate-stale", headSha: "new" });
    const { merge, rules, usecase } = setup({ ...pr, author: { type: "Bot", id: 2 } });
    await usecase.execute(input);
    expect(merge).toHaveBeenCalledWith(4, "new");
    expect(rules).not.toHaveBeenCalled();
    expect(ciStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["未完了", "pending", "wait", "ci_pending"],
    ["失敗", "blocked", "block", "ci_failed"],
  ] as const)("CI が%sなら判定結果を記録して停止する", async (_name, ci, action, reasonCode) => {
    vi.mocked(ciStatus).mockResolvedValue(ci);
    const { merge, sink, usecase } = setup(pr);
    await usecase.execute(input);
    expect(merge).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining(`"decision":"${action}"`));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining(`"reason_code":"${reasonCode}"`));
  });

  it("取得した PR の repository が異なる場合は判定せず停止する", async () => {
    const { github, merge, sink, usecase } = setup(pr);
    vi.spyOn(github, "pullRequest").mockResolvedValue({ repositoryId: 2, pr });
    await usecase.execute(input);
    expect(decide).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"repository_mismatch"'));
  });

  it("CI イベントの SHA が現在の PR と一致しなければマージしない", async () => {
    const { merge, sink, usecase } = setup(pr);
    await usecase.execute({ ...input, kind: "commit", sha: "other", numbers: [4] });
    expect(merge).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"policy":"dispatch"'));
  });

  it("Merge API が拒否した場合は別の方式を試さない", async () => {
    const { merge, sink, usecase } = setup(pr);
    merge.mockResolvedValue({ merged: false, status: 405 });
    await usecase.execute(input);
    expect(merge).toHaveBeenCalledOnce();
    expect(merge).toHaveBeenCalledWith(4, "new");
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"decision":"merge_rejected"'));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"api_status":405'));
  });

  it("マージ済みの PR を再びマージしない", async () => {
    const { merge, usecase } = setup({ ...pr, state: "MERGED" });
    await usecase.execute(input);
    expect(merge).not.toHaveBeenCalled();
  });

  it.each([
    [
      "異なる Bot の承認",
      { reviews: [{ id: 1, state: "APPROVED", author: { type: "Bot", id: 4 }, commitOid: "new" }] },
    ],
    ["承認なし", { reviews: [] }],
    ["古い head の承認", { reviews: [{ id: 1, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "old" }] }],
  ])("%s ではマージしない", async (_name, change) => {
    const { merge, usecase } = setup({ ...pr, ...change });
    await usecase.execute(input);
    expect(merge).not.toHaveBeenCalled();
  });

  it.each([
    { decision: { kind: "skip", reasonCode: "unknown_author" }, action: "skip" },
    { decision: { kind: "violated", reasonCode: "opted_out" }, action: "block" },
    { decision: { kind: "undeterminable", reasonCode: "ci_pending" }, action: "wait" },
    { decision: { kind: "undeterminable", reasonCode: "api_error" }, action: "block" },
  ] as const)("共通判定が $decision.kind のとき $action として停止する", async ({ decision, action }) => {
    vi.mocked(decide).mockResolvedValue(decision);
    const { merge, sink, usecase } = setup(pr);
    await usecase.execute(input);
    expect(merge).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining(`"decision":"${action}"`));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining(`"reason_code":"${decision.reasonCode}"`));
  });
});

describe("評価の回数上限とログ", () => {
  it.each([
    [38, true],
    [39, false],
  ])("消費済み %i 回では評価開始を %s とする", async (count, allowed) => {
    const { github, merge, usecase } = setup(pr);
    vi.spyOn(github, "subrequests").mockReturnValue(count);
    await usecase.execute(input);
    expect(merge.mock.calls.length).toBe(allowed ? 1 : 0);
  });

  it("最初の評価後に subrequest の残りが不足したら後続 PR を評価しない", async () => {
    const { github, merge, sink, usecase } = setup(pr);
    vi.spyOn(github, "subrequests").mockReturnValueOnce(38).mockReturnValue(39);
    await usecase.execute({ ...input, kind: "commit", sha: "new", numbers: [4, 5] });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"subrequest_limit"'));
  });

  it("共通判定で停止しても分類した policy を記録する", async () => {
    vi.mocked(decide).mockResolvedValue({ kind: "violated", reasonCode: "opted_out" });
    const { sink, usecase } = setup({ ...pr, author: { type: "Bot", id: 2 } });
    await usecase.execute(input);
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"opted_out"'));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"policy":"renovate-stale"'));
  });

  it("認証失敗の API status を記録する", async () => {
    const { github, sink, usecase } = setup(pr);
    vi.spyOn(github, "authenticate").mockRejectedValue(Object.assign(new Error("unavailable"), { status: 401 }));
    vi.mocked(errorDetails).mockReturnValueOnce({
      reasonCode: "api_error",
      errorName: "ApiError",
      errorMessage: "GitHub request failed",
      apiStatus: 401,
    });
    await usecase.execute(input);
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"event":"job_failed"'));
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"api_status":401'));
  });

  it("関連 PR の取得失敗の API status を記録する", async () => {
    const { github, sink, usecase } = setup(pr);
    vi.spyOn(github, "associated").mockRejectedValue(Object.assign(new Error("unavailable"), { status: 403 }));
    vi.mocked(errorDetails).mockReturnValueOnce({
      reasonCode: "api_error",
      errorName: "ApiError",
      errorMessage: "GitHub request failed",
      apiStatus: 403,
    });
    await usecase.execute({ ...input, kind: "commit", sha: "new" });
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"event":"job_failed"'));
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"api_status":403'));
  });

  it("PR 取得失敗の API status を記録する", async () => {
    const { github, sink, usecase } = setup(pr);
    vi.spyOn(github, "pullRequest").mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }));
    vi.mocked(errorDetails).mockReturnValueOnce({
      reasonCode: "api_error",
      errorName: "ApiError",
      errorMessage: "GitHub request failed",
      apiStatus: 503,
    });
    await usecase.execute(input);
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"api_status":503'));
  });

  it.each([401, 403, 429])("Merge API のエラー %i の status と理由を記録する", async (status) => {
    const { merge, sink, usecase } = setup(pr);
    merge.mockRejectedValue(new Error("unavailable"));
    vi.mocked(errorDetails).mockReturnValueOnce({
      reasonCode: "api_error",
      errorName: "ApiError",
      errorMessage: "GitHub request failed",
      apiStatus: status,
    });
    await usecase.execute(input);
    expect(merge).toHaveBeenCalledOnce();
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"api_error"'));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining(`"api_status":${String(status)}`));
  });

  it.each(["timeout", "invalid_response", "connection_truncated"] as const)(
    "Merge API の %s を区別して記録する",
    async (reasonCode) => {
      const { merge, sink, usecase } = setup(pr);
      merge.mockRejectedValue(new Error("unavailable"));
      vi.mocked(errorDetails).mockReturnValueOnce({
        reasonCode,
        errorName: "GitHubDataError",
        errorMessage: "GitHub request failed",
        apiStatus: undefined,
      });
      await usecase.execute(input);
      expect(merge).toHaveBeenCalledOnce();
      expect(sink.info).toHaveBeenCalledWith(expect.stringContaining(`"reason_code":"${reasonCode}"`));
    }
  );

  it("PR 取得後のエラーには head と policy を記録する", async () => {
    const { sink, usecase } = setup(pr);
    vi.mocked(decide).mockRejectedValue(new Error("unavailable"));
    await usecase.execute(input);
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"head_sha":"new"'));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"policy":"dispatch"'));
    expect(sink.info).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"api_error"'));
  });
});
