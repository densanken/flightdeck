import { createLogger } from "@flightdeck/logger";
import { describe, expect, it, vi } from "vitest";

import { ApprovalUseCaseImpl } from "./impl.js";

import type { ApprovalDependencies, Candidate, ApprovalGateway, PullRequest } from "./dependencies.js";
import type { ReviewCommitInput, ReviewPullRequestsInput } from "./interface.js";

const now = Date.parse("2026-11-10T00:00:00Z");
const settings = { dispatchId: 1, renovateIds: [2], botUserId: 3 };
const pr: PullRequest = {
  state: "OPEN",
  draft: false,
  body: "",
  createdAt: "2026-01-01T00:00:00Z",
  branch: "branch",
  headSha: "head",
  mergeSha: null,
  baseBranch: "main",
  baseOid: "base",
  author: { type: "User", id: 10 },
  editor: null,
  lastEditedAt: null,
  headRepositoryId: 1,
  labels: [],
  files: [],
  opinionatedReviews: [],
  reviews: [],
  timeline: [],
  timelinePageCount: 0,
  timelineHasPreviousPage: false,
  recentCount: 0,
  submodules: [],
  submodulesComplete: true,
  checks: [],
  statuses: [],
};
const candidate = (number: number): Candidate => ({
  number,
  authorId: 2,
  headSha: "head",
  reviewsComplete: true,
  reviews: [],
});
const renovate: PullRequest = {
  ...pr,
  author: { type: "Bot", id: 2 },
  body: "**Automerge**: Disabled by config.",
  checks: [{ name: "ci", status: "queued", conclusion: null, app: { id: 5, slug: "github-actions" } }],
};
const passed = [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }];

const job: ReviewPullRequestsInput = {
  deliveryId: "delivery",
  repository: "org/repo",
  repositoryId: 1,
  installationId: 1,
  numbers: [1],
  sweep: true,
  dismissOnly: false,
};
const commit = (sha: string): ReviewCommitInput => ({
  deliveryId: job.deliveryId,
  installationId: job.installationId,
  repositoryId: job.repositoryId,
  repository: job.repository,
  sha,
});

const logger = createLogger("error", { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const gateway = (): ApprovalGateway => ({
  authenticate: vi.fn(() => Promise.resolve()),
  associated: vi.fn(() => Promise.resolve([])),
  search: vi.fn(() => Promise.resolve([])),
  pullRequest: vi.fn(() => Promise.resolve({ repositoryId: 1, pr })),
  configs: vi.fn(() => Promise.resolve([])),
  trees: vi.fn(() => Promise.resolve({ base: null, head: null })),
  compare: vi.fn(() => Promise.resolve({ source: "BEHIND", ancestry: "behind" })),
  rules: vi.fn(() => Promise.resolve([])),
  approve: vi.fn(() => Promise.resolve({ status: 200, reviewId: 9 })),
  dismiss: vi.fn(() => Promise.resolve({ status: 200 })),
  reviewState: vi.fn(() => Promise.resolve("APPROVED")),
  subrequests: vi.fn(() => 0),
});

const setup = (github: ApprovalGateway, options: Partial<ApprovalDependencies> = {}) =>
  new ApprovalUseCaseImpl({
    settings,
    github,
    logger,
    clock: () => now,
    random: () => 0,
    maxSubrequests: 45,
    ...options,
  });

describe("PR の評価と探索", () => {
  it("対象 PR を優先し候補を絞って乱数位置から巡回する", async () => {
    const client = gateway();
    vi.mocked(client.search).mockResolvedValue([
      candidate(1),
      { ...candidate(20), authorId: 8 },
      { ...candidate(21), reviewsComplete: false },
      { ...candidate(22), reviews: [{ id: 4, state: "APPROVED", author: { type: "Bot", id: 3 }, commitOid: "head" }] },
      ...[2, 3, 4, 5, 6, 7].map(candidate),
    ]);

    await setup(client, { random: () => 0.5 }).reviewPullRequests(job);

    expect(vi.mocked(client.pullRequest).mock.calls.map(([number]) => number)).toEqual([1, 5, 6, 7, 2, 3]);
    expect(client.search).toHaveBeenCalledWith("2026-10-11");
  });

  it("対象 PR がなければ探索だけを行う", async () => {
    const client = gateway();

    await setup(client).reviewPullRequests({ ...job, numbers: [] });

    expect(client.pullRequest).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it("最新の Ready 状態を取得して承認し、Dismiss だけを行う評価では承認しない", async () => {
    const client = gateway();
    const dispatch: PullRequest = {
      ...pr,
      author: { type: "Bot", id: 1 },
      branch: "flightdeck-dispatch/org/source",
      files: [{ path: "sub", changeType: "MODIFIED" }],
      submodules: [{ path: "sub", gitUrl: "https://github.com/org/source.git" }],
    };
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: dispatch });
    vi.mocked(client.trees).mockResolvedValue({
      base: { type: "commit", oid: "old" },
      head: { type: "commit", oid: "new" },
    });

    await setup(client).reviewPullRequests({ ...job, numbers: [9] });

    expect(client.pullRequest).toHaveBeenCalledWith(9, now);
    expect(client.approve).toHaveBeenCalledWith(9, "head");

    vi.mocked(client.approve).mockClear();

    await setup(client).reviewPullRequests({ ...job, numbers: [9], dismissOnly: true });

    expect(client.approve).not.toHaveBeenCalled();
  });
});

describe("commit に関連する PR の評価", () => {
  it("check suite が示す PR を SHA が head と一致すれば承認する", async () => {
    const client = gateway();
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...renovate, checks: passed } });

    await setup(client).reviewCommit({ ...commit("head"), numbers: [2] });

    expect(client.approve).toHaveBeenCalledWith(2, "head");
    expect(client.associated).not.toHaveBeenCalled();
  });

  it("イベントの repository 内の関連 PR だけを評価し、探索しない", async () => {
    const client = gateway();
    vi.mocked(client.associated).mockResolvedValue([4]);

    await setup(client).reviewCommit(commit("head"));

    expect(client.associated).toHaveBeenCalledWith("head", 1);
    expect(client.pullRequest).toHaveBeenCalledWith(4, now);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("関連 PR を取得できない場合は評価もレビュー操作もしない", async () => {
    const client = gateway();
    vi.mocked(client.associated).mockRejectedValue(new Error("incomplete"));

    await setup(client).reviewCommit(commit("head"));

    expect(client.pullRequest).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it("古い SHA に関連した PR の承認や撤回を行わない", async () => {
    const client = gateway();
    vi.mocked(client.associated).mockResolvedValue([2]);
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...pr, author: { type: "Bot", id: 1 } } });

    await setup(client).reviewCommit(commit("stale"));

    expect(client.associated).toHaveBeenCalledWith("stale", 1);
    expect(client.configs).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
    expect(client.dismiss).not.toHaveBeenCalled();
  });

  it("探索で pending だった候補を CI 完了後に承認する", async () => {
    const client = gateway();
    vi.mocked(client.search).mockResolvedValue([candidate(2)]);
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: renovate });

    await setup(client).reviewPullRequests({ ...job, numbers: [] });

    expect(client.approve).not.toHaveBeenCalled();

    vi.mocked(client.associated).mockResolvedValue([2]);
    vi.mocked(client.pullRequest).mockResolvedValue({ repositoryId: 1, pr: { ...renovate, checks: passed } });

    await setup(client).reviewCommit(commit("head"));

    expect(client.approve).toHaveBeenCalledWith(2, "head");
  });
});

describe("実行上限", () => {
  it("残り 7 回なら評価し、6 回なら停止理由を記録する", async () => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const output = createLogger("info", sink);
    vi.mocked(client.subrequests).mockReturnValue(38);

    await setup(client, { logger: output }).reviewPullRequests({ ...job, sweep: false });

    expect(client.pullRequest).toHaveBeenCalledTimes(1);

    vi.mocked(client.pullRequest).mockClear();
    vi.mocked(client.subrequests).mockReturnValue(39);

    await setup(client, { logger: output }).reviewPullRequests(job);

    expect(client.pullRequest).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"subrequest_limit"'));
  });

  it("対象の評価で予算が尽きたら探索しない", async () => {
    const client = gateway();
    vi.mocked(client.subrequests).mockReturnValue(38);
    vi.mocked(client.pullRequest).mockImplementation(() => {
      vi.mocked(client.subrequests).mockReturnValue(39);
      return Promise.resolve({ repositoryId: 1, pr });
    });

    await setup(client).reviewPullRequests(job);

    expect(client.pullRequest).toHaveBeenCalledTimes(1);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("25 秒経過による停止を記録する", async () => {
    const client = gateway();
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const clock = vi
      .fn()
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 25_000);

    await setup(client, { logger: createLogger("info", sink), clock }).reviewPullRequests(job);

    expect(client.pullRequest).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledWith(expect.stringContaining('"reason_code":"time_limit"'));
  });
});
