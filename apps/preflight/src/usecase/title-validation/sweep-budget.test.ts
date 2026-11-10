import { describe, expect, it, vi } from "vitest";

import { ValidatePullRequestTitleUseCaseImpl } from "./impl.js";

import type { PullRequestCommitTitleStatus, TitleValidationGateway } from "./dependencies.js";

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

describe("sweep の通信予算", () => {
  it("旧 SHA の再判定を通常処理の予算内で完了する", async () => {
    const budget = createTestBudget();
    // pending、認証、delivery cache、コメントなどの通信枠を先に消費する
    for (let i = 0; i < 8; i += 1) budget.consume("normal");
    const normal = createGateway();
    const sweep = createGateway();
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    vi.mocked(normal.getCurrentPolicyState).mockImplementation(({ headSha }) => {
      budget.consume("normal");
      return Promise.resolve({
        current: { title: "feat: current", headSha: "current", state: "open", draft: false },
        associatedPullRequests:
          headSha === "old" ? [] : [{ number: 7, title: "feat: current", headSha: "current", draft: false }],
      });
    });
    vi.mocked(normal.setTitleStatus).mockImplementation(() => {
      budget.consume("normal");
      return Promise.resolve();
    });
    vi.mocked(normal.listOpenPullRequestsForHeadShas).mockImplementation(() => {
      for (let i = 0; i < 6; i += 1) budget.consume("normal");
      return Promise.resolve([]);
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
        sweep,
        recovery,
        recoveryStatus,
        budget,
        log: vi.fn(),
      }).execute({ ...command(), fallbackHeadSha: "current", previousHeadSha: "old" }, new AbortController().signal)
    ).resolves.toMatchObject({ result: "valid" });
    expect(normal.listOpenPullRequestsForHeadShas).not.toHaveBeenCalled();
    expect(normal.getCurrentPolicyState).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: "old" }),
      expect.anything()
    );
    expect(normal.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "old", state: "success" }),
      expect.anything()
    );
    expect(recovery.setTitleStatus).not.toHaveBeenCalled();
    expect(budget.remaining("normal")).toBeGreaterThan(0);
  });

  it("書き込み前に確認する SHA の数を投稿枠の 3 倍に制限する", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const commits = Array.from({ length: 250 }, (_, index) => commitStatus(`old-${String(index)}`));
    const sweep = createGateway({ commitStatuses: commits });
    vi.mocked(sweep.confirmSweepCommits).mockImplementation(({ shas }) =>
      Promise.resolve(new Map(shas.map((sha) => [sha, []])))
    );
    await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      sweep,
      recovery: createGateway(),
      recoveryStatus: createGateway(),
      budget,
      log: vi.fn(),
    }).execute(command(), new AbortController().signal);
    expect(vi.mocked(sweep.confirmSweepCommits).mock.calls[0]?.[0].shas).toEqual(
      commits.slice(0, 9).map(({ sha }) => sha)
    );
  });

  it("先行候補が掃除できなくても次の候補を予算内で確認する", async () => {
    const budget = createTestBudget();
    const commits = Array.from({ length: 10 }, (_, index) => commitStatus(`old-${String(index)}`));
    const sweep = createGateway({ commitStatuses: commits });
    vi.mocked(sweep.confirmSweepCommits).mockImplementation(({ shas }) => {
      budget.consume("sweep");
      return Promise.resolve(
        new Map(
          shas.map((sha) => [sha, sha === "old-9" ? [] : [{ number: 8, title: "invalid", headSha: sha, draft: false }]])
        )
      );
    });
    await new ValidatePullRequestTitleUseCaseImpl(createGateway(), () => 42, {
      sweep,
      recovery: createGateway(),
      recoveryStatus: createGateway(),
      budget,
      log: vi.fn(),
    }).execute(command(), new AbortController().signal);
    expect(sweep.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "old-9", state: "success" }),
      expect.anything()
    );
    expect(
      vi
        .mocked(sweep.confirmSweepCommits)
        .mock.calls.slice(0, 2)
        .map(([input]) => input.shas.length)
    ).toEqual([9, 1]);
  });

  it("比較不能な候補を走査せず、安全な候補を予算内で掃除する", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const sweep = createGateway({ commitStatuses: [commitStatus("unknown"), commitStatus("safe")] });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const log = vi.fn();
    vi.mocked(sweep.listPullRequestCommitTitleStatuses).mockImplementation(() => {
      budget.consume("sweep");
      return Promise.resolve([commitStatus("unknown"), commitStatus("safe")]);
    });
    vi.mocked(sweep.confirmSweepCommits).mockImplementation(({ shas }) => {
      budget.consume("sweep");
      return Promise.resolve(new Map(shas.map((sha) => [sha, sha === "unknown" ? undefined : []])));
    });
    vi.mocked(sweep.listOpenPullRequestsForHeadShas).mockImplementation(() => {
      for (let i = 0; i < 6; i += 1) budget.consume("sweep");
      return Promise.resolve([]);
    });
    vi.mocked(sweep.setTitleStatus).mockImplementation(() => {
      budget.consume("sweep");
      return Promise.resolve();
    });

    const result = await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      sweep,
      recovery,
      recoveryStatus,
      budget,
      log,
    }).execute(command(), new AbortController().signal);

    expect(result).toMatchObject({ supersededStatusesCleared: 1, supersededSweepFailed: false });
    expect(sweep.listOpenPullRequestsForHeadShas).not.toHaveBeenCalled();
    expect(sweep.setTitleStatus).toHaveBeenCalledWith(expect.objectContaining({ sha: "safe" }), expect.anything());
    expect(log).toHaveBeenCalledWith("superseded_comparison_skipped", 1);
  });

  it.each([
    { title: "invalid", draft: false, verdict: "failure" },
    { title: "feat: valid", draft: true, verdict: "pending" },
  ])("一覧が古くても現在 PR の title と draft を予算で判定する: $verdict", async (current) => {
    const budget = createTestBudget();
    const normal = createGateway();
    const sweep = createGateway();
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    vi.mocked(normal.listIssueComments).mockRejectedValue(new Error("comment failed"));
    vi.mocked(recovery.getCurrentPolicyState).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve({
        current: { ...current, headSha: "abc123", state: "open" },
        associatedPullRequests: undefined,
      });
    });
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockImplementation(({ headShas: [headSha = ""] }) => {
      budget.consume("recovery");
      return Promise.resolve([{ number: 7, title: "feat: old", headSha, draft: false }]);
    });
    vi.mocked(recovery.setTitleStatus).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve();
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
        sweep,
        recovery,
        recoveryStatus,
        budget,
        log: vi.fn(),
      }).execute(command(), new AbortController().signal)
    ).rejects.toMatchObject({ stage: "comment_sync_failed" });

    expect(vi.mocked(recovery.setTitleStatus).mock.calls.map(([input]) => input.state)).toEqual([current.verdict]);
    expect(recoveryStatus.setTitleStatus).not.toHaveBeenCalled();
    expect(budget.remaining("recovery")).toBeGreaterThanOrEqual(0);
  });

  it("closed PR のコメント取得に失敗しても予算で共有 head の verdict を維持する", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const sweep = createGateway();
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const current = { title: "feat: closed", headSha: "abc123", state: "closed" as const, draft: false };
    const shared = [{ number: 8, title: "fix: shared", headSha: "abc123", draft: false }];
    vi.mocked(normal.getCurrentPolicyState).mockResolvedValue({
      current,
      associatedPullRequests: shared,
    });
    vi.mocked(normal.listIssueComments).mockRejectedValue(new Error("comment failed"));
    vi.mocked(recovery.getCurrentPolicyState).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve({ current, associatedPullRequests: undefined });
    });
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve(shared);
    });
    vi.mocked(recovery.setTitleStatus).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve();
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
        sweep,
        recovery,
        recoveryStatus,
        budget,
        log: vi.fn(),
      }).execute(command(), new AbortController().signal)
    ).rejects.toMatchObject({ stage: "comment_sync_failed" });
    expect(recovery.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "abc123", state: "success" }),
      expect.anything()
    );
    expect(recoveryStatus.setTitleStatus).not.toHaveBeenCalled();
    expect(budget.remaining("recovery")).toBeGreaterThanOrEqual(0);
  });

  it("recovery で head が変われば投稿済み SHA を error で保護する", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const sweep = createGateway();
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const state = (headSha: string) => ({
      current: { title: "feat: current", headSha, state: "open" as const, draft: false },
      associatedPullRequests: [{ number: 7, title: "feat: current", headSha, draft: false }],
    });
    vi.mocked(normal.getCurrentPolicyState).mockImplementation(() => {
      budget.consume("normal");
      return Promise.resolve(state("X"));
    });
    vi.mocked(normal.setTitleStatus).mockImplementation(() => {
      budget.consume("normal");
      return Promise.resolve();
    });
    vi.mocked(normal.listIssueComments).mockRejectedValue(new Error("comment failed"));
    vi.mocked(recovery.getCurrentPolicyState).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve(state("Y"));
    });
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockImplementation(({ headShas: [headSha = ""] }) => {
      budget.consume("recovery");
      return Promise.resolve([
        {
          number: headSha === "X" ? 8 : 7,
          title: headSha === "X" ? "invalid" : "feat: current",
          headSha,
          draft: false,
        },
      ]);
    });
    vi.mocked(recovery.setTitleStatus).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve();
    });
    vi.mocked(recoveryStatus.setTitleStatus).mockImplementation(() => {
      budget.consume("recovery_status");
      return Promise.resolve();
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
        sweep,
        recovery,
        recoveryStatus,
        budget,
        log: vi.fn(),
      }).execute({ ...command(), fallbackHeadSha: "X" }, new AbortController().signal)
    ).rejects.toMatchObject({ stage: "comment_sync_failed" });

    expect(normal.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "X", state: "success" }),
      expect.anything()
    );
    expect(recovery.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "Y", state: "success" }),
      expect.anything()
    );
    expect(recoveryStatus.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "X", state: "error" }),
      expect.anything()
    );
    expect(budget.remaining("recovery")).toBeGreaterThanOrEqual(0);
  });

  it("現在 head の投稿が 3 回の再試行で枠を使い切ると旧 SHA は投稿できない", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const sweep = createGateway();
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    vi.mocked(normal.getCurrentPolicyState).mockResolvedValue({
      current: { title: "feat: current", headSha: "current", state: "open", draft: false },
      associatedPullRequests: [],
    });
    vi.mocked(normal.getAuthenticatedAppBotUserId).mockRejectedValue(new Error("identity failed"));
    vi.mocked(recoveryStatus.setTitleStatus).mockImplementation((input) => {
      if (input.sha === "current") {
        for (let i = 0; i < 3; i += 1) budget.consume("recovery_status");
      } else {
        budget.consume("recovery_status");
      }
      return Promise.resolve();
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
        sweep,
        recovery,
        recoveryStatus,
        budget,
        log: vi.fn(),
      }).execute(command(), new AbortController().signal)
    ).rejects.toMatchObject({ stage: "identity_validation_failed" });

    expect(vi.mocked(recoveryStatus.setTitleStatus).mock.calls.map(([input]) => input.sha)).toEqual([
      "current",
      "abc123",
    ]);
    expect(budget.remaining("recovery_status")).toBe(0);
  });

  it("recovery 中に head が変わり走査が失敗しても投稿済み SHA を保護する", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const sweep = createGateway();
    const current = (headSha: string) => ({
      current: { title: "feat: current", headSha, state: "open" as const, draft: false },
      associatedPullRequests: [],
    });
    vi.mocked(normal.getCurrentPolicyState).mockImplementation(() => {
      budget.consume("normal");
      return Promise.resolve({ ...current("X"), associatedPullRequests: undefined });
    });
    vi.mocked(normal.getAuthenticatedAppBotUserId).mockImplementation(() => {
      budget.consume("normal");
      return Promise.resolve(42);
    });
    vi.mocked(normal.setTitleStatus).mockImplementation(() => {
      budget.consume("normal");
      return Promise.resolve();
    });
    let oldReads = 0;
    vi.mocked(normal.listOpenPullRequestsForHeadShas).mockImplementation(({ headShas: [headSha = ""] }) => {
      budget.consume("normal");
      oldReads += 1;
      return Promise.resolve([{ number: 8, title: oldReads % 2 ? "feat: valid" : "invalid", headSha, draft: false }]);
    });
    vi.mocked(recovery.getCurrentPolicyState).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve({ ...current("Y"), associatedPullRequests: undefined });
    });
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockImplementation(({ headShas: [headSha = ""] }) => {
      budget.consume("recovery");
      if (headSha === "Y") return Promise.reject(new Error("scan failed"));
      return Promise.resolve([{ number: 9, title: "invalid", headSha, draft: false }]);
    });
    vi.mocked(recovery.setTitleStatus).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve();
    });
    vi.mocked(recoveryStatus.setTitleStatus).mockImplementation(() => {
      budget.consume("recovery_status");
      return Promise.resolve();
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
        sweep,
        recovery,
        recoveryStatus,
        budget,
        log: vi.fn(),
      }).execute({ ...command(), fallbackHeadSha: "F" }, new AbortController().signal)
    ).rejects.toMatchObject({
      stage: "state_changed",
    });

    expect(recoveryStatus.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "Y", state: "error" }),
      expect.anything()
    );
    expect(recovery.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "X", state: "failure" }),
      expect.anything()
    );
    const posted = new Set(
      [normal, recovery, recoveryStatus].flatMap((gateway) =>
        vi.mocked(gateway.setTitleStatus).mock.calls.map(([input]) => input.sha)
      )
    );
    const errors = [normal, recovery, recoveryStatus].flatMap((gateway) =>
      vi
        .mocked(gateway.setTitleStatus)
        .mock.calls.map(([input]) => input)
        .filter((input) => input.state === "error")
        .map((input) => input.sha)
    );
    const confirmed = vi
      .mocked(recovery.listOpenPullRequestsForHeadShas)
      .mock.calls.map(([input]) => input.headShas[0])
      .filter((sha, _, reads) => reads.filter((read) => read === sha).length >= 2);
    expect([...posted].every((sha) => errors.includes(sha) || confirmed.includes(sha))).toBe(true);
    expect(budget.remaining("recovery")).toBeGreaterThanOrEqual(0);
    expect(budget.remaining("recovery_status")).toBeGreaterThanOrEqual(0);
  });

  it("予算で複数 SHA を一括走査し、修復後も 6 ページ走査して確認する", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const sweep = createGateway({ commitStatuses: [commitStatus("old-1"), commitStatus("old-2")] });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const shared = [
      { number: 8, title: "feat: first", headSha: "old-1", draft: false },
      { number: 9, title: "fix: second", headSha: "old-2", draft: false },
    ];
    vi.mocked(sweep.listPullRequestCommitTitleStatuses).mockImplementation(() => {
      for (let i = 0; i < 3; i += 1) budget.consume("sweep");
      return Promise.resolve([commitStatus("old-1"), commitStatus("old-2")]);
    });
    vi.mocked(sweep.setTitleStatus).mockImplementation(() => {
      budget.consume("sweep");
      return Promise.resolve();
    });
    let sweepConfirmations = 0;
    for (const [gateway, purpose] of [
      [sweep, "sweep"],
      [recovery, "recovery"],
    ] as const) {
      vi.mocked(gateway.confirmSweepCommits).mockImplementation(({ shas }) => {
        budget.consume(purpose);
        const initial = purpose === "sweep" && sweepConfirmations++ === 0;
        return Promise.resolve(new Map(shas.map((sha) => [sha, initial ? [] : undefined])));
      });
      vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockImplementation(() => {
        for (let i = 0; i < 6; i += 1) budget.consume(purpose);
        return Promise.resolve(shared);
      });
    }
    const result = await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      sweep,
      recovery,
      recoveryStatus,
      budget,
      log: vi.fn(),
    }).execute(command(), new AbortController().signal);
    expect(result).toMatchObject({ supersededStatusesCleared: 2, supersededSweepFailed: false });
    expect(budget.remaining("sweep")).toBe(1);
    expect(budget.remaining("recovery")).toBe(0);
    expect(sweep.listOpenPullRequestsForHeadShas).toHaveBeenCalledOnce();
    expect(recovery.listOpenPullRequestsForHeadShas).toHaveBeenCalledOnce();
    expect(sweep.setTitleStatus).toHaveBeenCalledTimes(4);
    expect(recoveryStatus.setTitleStatus).not.toHaveBeenCalled();
  });

  it("先行 SHA の修復と保護に失敗しても後続 SHA の保護枠を残す", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const shas = ["old-1", "old-2", "old-3"];
    const sweep = createGateway({ commitStatuses: shas.map(commitStatus) });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const shared = (sha: string, title = "feat: valid") => ({
      number: shas.indexOf(sha) + 8,
      title,
      headSha: sha,
      draft: false,
    });

    vi.mocked(sweep.listPullRequestCommitTitleStatuses).mockImplementation(() => {
      budget.consume("sweep");
      return Promise.resolve(shas.map(commitStatus));
    });
    let confirmations = 0;
    vi.mocked(sweep.confirmSweepCommits).mockImplementation(({ shas: candidates }) => {
      budget.consume("sweep");
      const initial = confirmations++ === 0;
      return Promise.resolve(new Map(candidates.map((sha) => [sha, initial ? [] : [shared(sha)]])));
    });
    vi.mocked(sweep.setTitleStatus).mockImplementation((input) => {
      budget.consume("sweep");
      if (input.sha !== "old-3") {
        // 初回の掃除と修復は同じ success なので投稿順で判定する
        const calls = vi.mocked(sweep.setTitleStatus).mock.calls.filter(([status]) => status.sha === input.sha);
        if (calls.length > 1) return Promise.reject(new Error("repair failed"));
      }
      return Promise.resolve();
    });
    vi.mocked(recovery.confirmSweepCommits).mockImplementation(({ shas: candidates }) => {
      budget.consume("recovery");
      return Promise.resolve(new Map(candidates.map((sha) => [sha, [shared(sha, "invalid")]])));
    });
    vi.mocked(recoveryStatus.setTitleStatus).mockImplementation((input) => {
      budget.consume("recovery_status");
      if (input.sha !== "old-3") return Promise.reject(new Error("protection failed"));
      return Promise.resolve();
    });

    const result = await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      sweep,
      recovery,
      recoveryStatus,
      budget,
      log: vi.fn(),
    }).execute(command(), new AbortController().signal);

    expect(result).toMatchObject({ supersededStatusesCleared: 3, supersededSweepFailed: true });
    expect(vi.mocked(recoveryStatus.setTitleStatus).mock.calls.map(([input]) => [input.sha, input.state])).toEqual(
      shas.map((sha) => [sha, "error"])
    );
    expect(budget.remaining("recovery_status")).toBe(0);
  });

  it("3 SHA の修復後確認に失敗しても予算内で全 SHA を error にする", async () => {
    const budget = createTestBudget();
    const normal = createGateway();
    const shas = ["old-1", "old-2", "old-3", "old-4"];
    const sweep = createGateway({ commitStatuses: shas.map(commitStatus) });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const shared = shas.map((headSha, index) => ({
      number: index + 8,
      title: "feat: shared head",
      headSha,
      draft: false,
    }));
    for (let i = 0; i < 24; i += 1) budget.consume("normal");
    vi.mocked(sweep.listPullRequestCommitTitleStatuses).mockImplementation(() => {
      budget.consume("sweep");
      return Promise.resolve(shas.map(commitStatus));
    });
    vi.mocked(sweep.setTitleStatus).mockImplementation(() => {
      budget.consume("sweep");
      return Promise.resolve();
    });
    let sweepConfirmations = 0;
    vi.mocked(sweep.confirmSweepCommits).mockImplementation(({ shas: candidates }) => {
      budget.consume("sweep");
      const initial = sweepConfirmations++ === 0;
      return Promise.resolve(new Map(candidates.map((sha) => [sha, initial ? [] : undefined])));
    });
    vi.mocked(sweep.listOpenPullRequestsForHeadShas).mockImplementation(() => {
      for (let i = 0; i < 6; i += 1) budget.consume("sweep");
      return Promise.resolve(shared);
    });
    vi.mocked(recovery.confirmSweepCommits).mockImplementation(() => {
      budget.consume("recovery");
      return Promise.resolve(new Map(shas.map((sha) => [sha, undefined])));
    });
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockImplementation(() => {
      for (let i = 0; i < 6; i += 1) budget.consume("recovery");
      return Promise.reject(new Error("confirmation failed"));
    });
    vi.mocked(recoveryStatus.setTitleStatus).mockImplementation(() => {
      budget.consume("recovery_status");
      return Promise.resolve();
    });

    const log = vi.fn();
    const result = await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      sweep,
      recovery,
      recoveryStatus,
      budget,
      log,
    }).execute(command(), new AbortController().signal);

    expect(result).toMatchObject({ supersededStatusesCleared: 3, supersededSweepFailed: true });
    expect(vi.mocked(sweep.setTitleStatus).mock.calls.map(([input]) => input.sha)).toEqual([
      ...shas.slice(0, 3),
      ...shas.slice(0, 3),
    ]);
    expect(log).toHaveBeenCalledWith("superseded_sweep_budget_exhausted", 1);
    expect(vi.mocked(recoveryStatus.setTitleStatus).mock.calls.map(([input]) => [input.sha, input.state])).toEqual(
      shas.slice(0, 3).map((sha) => [sha, "error"])
    );
    expect(budget.remaining("recovery_status")).toBe(0);
    const total =
      50 -
      (["normal", "sweep", "recovery", "recovery_status"] as const).reduce(
        (remaining, purpose) => remaining + budget.remaining(purpose),
        0
      );
    expect(total).toBeLessThanOrEqual(50);
    expect(total).toBe(49);
  });
});
