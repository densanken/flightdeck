import { describe, expect, it, vi } from "vitest";

import { setPullRequestTitleStatus } from "../infrastructure/github/commit-status.js";
import { ValidatePullRequestTitleUseCaseImpl } from "../usecase/title-validation/impl.js";

import type { PullRequestCommitTitleStatus, TitleValidationGateway } from "../usecase/title-validation/dependencies.js";

const createTestBudget = () => {
  const remaining = { normal: 24, sweep: 16, recovery: 7, recovery_status: 3 };
  return {
    consume: (phase: keyof typeof remaining) => {
      if (remaining[phase] === 0) throw new Error("Budget exhausted");
      remaining[phase] -= 1;
    },
    remaining: (phase: keyof typeof remaining) => remaining[phase],
  };
};

const commitStatus = (sha: string): PullRequestCommitTitleStatus => ({
  sha,
  statusState: "not_success",
});
const command = () => ({ owner: "owner", repo: "repo", pullRequestNumber: 7, fallbackHeadSha: "abc123" });
const createGateway = (input: { commitStatuses?: PullRequestCommitTitleStatus[] } = {}): TitleValidationGateway => ({
  getCurrentPolicyState: vi.fn().mockResolvedValue({
    current: { title: "feat: add login", headSha: "abc123", state: "open", draft: false },
    associatedPullRequests: [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }],
  }),
  listOpenPullRequestsForHeadShas: vi.fn().mockResolvedValue([]),
  getAuthenticatedAppBotUserId: vi.fn().mockResolvedValue(42),
  listPullRequestCommitTitleStatuses: vi.fn().mockResolvedValue(input.commitStatuses ?? []),
  confirmSweepCommits: vi.fn().mockResolvedValue(new Map()),
  setTitleStatus: vi.fn().mockResolvedValue(undefined),
  listIssueComments: vi.fn().mockResolvedValue([]),
  createIssueComment: vi.fn().mockResolvedValue(undefined),
  updateIssueComment: vi.fn().mockResolvedValue(undefined),
  deleteIssueComment: vi.fn().mockResolvedValue(undefined),
});

describe("sweep の修復投稿", () => {
  it("修復投稿の HTTP エラーで別 SHA の予約枠を消費しない", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const shas = ["old-1", "old-2"];
    const sweep = createGateway({ commitStatuses: shas.map(commitStatus) });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const shared = shas.map((headSha, index) => ({
      number: index + 8,
      title: "feat: shared",
      headSha,
      draft: false,
    }));
    vi.mocked(sweep.listPullRequestCommitTitleStatuses).mockImplementation(() => {
      for (let i = 0; i < 3; i += 1) budget.consume("sweep");
      return Promise.resolve(shas.map(commitStatus));
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      budget.consume("sweep");
      const body = JSON.parse(init?.body as string) as { description: string };
      const failure = body.description !== "PR の最新 commit ではありません" && fetchImpl.mock.calls.length === 3;
      return Promise.resolve(new Response("{}", { status: failure ? 503 : 201 }));
    });
    vi.mocked(sweep.setTitleStatus).mockImplementation((input, signal) =>
      setPullRequestTitleStatus({ ...input, installationToken: "token", fetchImpl, signal })
    );
    let calls = 0;
    vi.mocked(sweep.confirmSweepCommits).mockImplementation(({ shas: candidates }) => {
      budget.consume("sweep");
      return Promise.resolve(new Map(candidates.map((sha) => [sha, calls++ < 2 ? [] : undefined])));
    });
    vi.mocked(sweep.listOpenPullRequestsForHeadShas).mockImplementation(() => {
      for (let i = 0; i < 6; i += 1) budget.consume("sweep");
      return Promise.resolve(shared);
    });
    vi.mocked(recovery.confirmSweepCommits).mockResolvedValue(
      new Map([["old-2", [{ number: 9, title: "feat: shared", headSha: "old-2", draft: false }]]])
    );

    const result = await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      sweep,
      recovery,
      recoveryStatus,
      budget,
      log: vi.fn(),
    }).execute(command(), new AbortController().signal);

    expect(result).toMatchObject({ supersededStatusesCleared: 2, supersededSweepFailed: true });
    expect(fetchImpl.mock.calls.map(([url]) => (url as string).split("/").at(-1))).toEqual(shas.concat(shas));
    expect(budget.remaining("sweep")).toBe(1);
    expect(recoveryStatus.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "old-1", state: "error" }),
      expect.anything()
    );
  });
});
