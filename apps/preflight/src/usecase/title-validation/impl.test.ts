import { describe, expect, it, vi } from "vitest";

import { TitleValidationExecutionError } from "./errors.js";
import { ValidatePullRequestTitleUseCaseImpl } from "./impl.js";
import { PR_TITLE_COMMENT_MARKER } from "../../domain/title-comment.js";
import { ConfigurationError } from "../../errors.js";

import type {
  AssociatedPullRequestTitle,
  IssueComment,
  PullRequestCommitTitleStatus,
  PullRequestTitleState,
  TitleValidationGateway,
} from "./dependencies.js";

const commitStatus = (
  sha: string,
  overrides: Partial<Omit<PullRequestCommitTitleStatus, "sha">> = {}
): PullRequestCommitTitleStatus => ({
  sha,
  statusState: "not_success",
  ...overrides,
});

const command = (overrides: { fallbackHeadSha?: string; previousHeadSha?: string } = {}) => ({
  owner: "owner",
  repo: "repo",
  pullRequestNumber: 7,
  fallbackHeadSha: "abc123",
  ...overrides,
});

const comment = (
  id: number,
  userId: number,
  body: string | null = "### Pull Request のタイトルを修正してください\n\nold"
): IssueComment => ({
  id,
  body,
  user: { id: userId },
});

const pullRequestState = (
  title: string,
  headSha: string,
  state: PullRequestTitleState["state"] = "open",
  draft = false
): PullRequestTitleState => ({ title, headSha, state, draft });

const validState = (): PullRequestTitleState => pullRequestState("feat: add login", "abc123");

const createGateway = (
  input: {
    comments?: IssueComment[];
    states?: PullRequestTitleState[];
    associatedStates?: AssociatedPullRequestTitle[][];
    authenticatedAppBotUserId?: number;
    commitStatuses?: PullRequestCommitTitleStatus[];
  } = {}
): TitleValidationGateway => {
  const states = input.states ?? [validState()];
  let stateIndex = 0;
  let associatedStateIndex = 0;
  let lastState = states[0] ?? validState();
  const comments = (input.comments ?? []).map((candidate) => ({
    ...candidate,
    user: candidate.user ? { ...candidate.user } : null,
  }));
  let nextCommentId = Math.max(0, ...comments.map((candidate) => candidate.id)) + 1;
  const getCurrentPullRequestTitleState: (request: unknown, signal: AbortSignal) => Promise<PullRequestTitleState> = (
    _request,
    signal
  ) => {
    if (signal.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    }
    const state = states[Math.min(stateIndex, states.length - 1)];
    stateIndex += 1;
    if (state) lastState = state;
    return state ? Promise.resolve(state) : Promise.reject(new Error("Missing test state"));
  };
  const gateway: TitleValidationGateway = {
    getCurrentPolicyState: vi.fn<TitleValidationGateway["getCurrentPolicyState"]>(async (request, signal) => ({
      current: await getCurrentPullRequestTitleState(request, signal),
      associatedPullRequests: undefined,
    })),
    listOpenPullRequestsForHeadShas: vi.fn<TitleValidationGateway["listOpenPullRequestsForHeadShas"]>(
      (request, signal) => {
        if (signal.aborted) {
          return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
        }
        if (input.associatedStates) {
          const associated = input.associatedStates[Math.min(associatedStateIndex, input.associatedStates.length - 1)];
          associatedStateIndex += 1;
          return associated ? Promise.resolve(associated) : Promise.reject(new Error("Missing associated test state"));
        }
        return Promise.resolve(
          lastState.state === "open" && request.headShas.includes(lastState.headSha)
            ? [{ number: 7, title: lastState.title, headSha: lastState.headSha, draft: lastState.draft }]
            : []
        );
      }
    ),
    getAuthenticatedAppBotUserId: vi.fn().mockResolvedValue(input.authenticatedAppBotUserId ?? 42),
    listPullRequestCommitTitleStatuses: vi.fn().mockResolvedValue(input.commitStatuses ?? []),
    confirmSweepCommits: vi.fn<TitleValidationGateway["confirmSweepCommits"]>(({ shas }) =>
      Promise.resolve(new Map(shas.map((sha) => [sha, []])))
    ),
    setTitleStatus: vi.fn().mockResolvedValue(undefined),
    listIssueComments: vi.fn<TitleValidationGateway["listIssueComments"]>(() =>
      Promise.resolve(
        comments.map((candidate) => ({ ...candidate, user: candidate.user ? { ...candidate.user } : null }))
      )
    ),
    createIssueComment: vi.fn<TitleValidationGateway["createIssueComment"]>((request) => {
      comments.push(comment(nextCommentId, 42, request.body));
      nextCommentId += 1;
      return Promise.resolve();
    }),
    updateIssueComment: vi.fn<TitleValidationGateway["updateIssueComment"]>((request) => {
      const existing = comments.find((candidate) => candidate.id === request.commentId);
      if (existing) existing.body = request.body;
      return Promise.resolve();
    }),
    deleteIssueComment: vi.fn<TitleValidationGateway["deleteIssueComment"]>((request) => {
      const index = comments.findIndex((candidate) => candidate.id === request.commentId);
      if (index >= 0) comments.splice(index, 1);
      return Promise.resolve();
    }),
  };
  return gateway;
};

const phases = (sweep: TitleValidationGateway, recovery = sweep, recoveryStatus = sweep) => ({
  sweep,
  recovery,
  recoveryStatus,
  budget: { remaining: vi.fn(() => 100) },
  log: vi.fn(),
});

describe("ValidatePullRequestTitleUseCaseImpl", () => {
  it("recovery は現在 head を優先し、残りの投稿枠で旧 SHA も fail-closed にする", async () => {
    const normal = createGateway({ states: [pullRequestState("feat: current", "new-sha")] });
    const recovery = createGateway({ states: [pullRequestState("feat: current", "new-sha")] });
    const recoveryStatus = createGateway();
    const sweep = createGateway();
    vi.mocked(normal.listOpenPullRequestsForHeadShas).mockRejectedValue(new Error("normal failed"));
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockRejectedValue(new Error("recovery failed"));
    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phases(sweep, recovery, recoveryStatus)).execute(
        command({ previousHeadSha: "old-sha" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_lookup_failed" });
    expect(vi.mocked(recovery.listOpenPullRequestsForHeadShas).mock.calls.map(([input]) => input.headShas[0])).toEqual([
      "new-sha",
      "abc123",
      "old-sha",
    ]);
    expect(vi.mocked(recoveryStatus.setTitleStatus).mock.calls.map(([input]) => [input.sha, input.retry])).toEqual([
      ["new-sha", false],
      ["abc123", false],
      ["old-sha", false],
    ]);
    expect(recovery.setTitleStatus).not.toHaveBeenCalled();
  });

  it("head 更新後の走査失敗時は投稿済みの旧 head も再取得して修復する", async () => {
    const normal = createGateway({
      states: [pullRequestState("feat: current", "X"), pullRequestState("feat: current", "Y")],
    });
    const recovery = createGateway({ states: [pullRequestState("feat: current", "Y")] });
    const recoveryStatus = createGateway();
    const sweep = createGateway();
    vi.mocked(normal.listOpenPullRequestsForHeadShas).mockImplementation(({ headShas: [headSha] }) =>
      headSha === "Y" ? Promise.reject(new Error("scan failed")) : Promise.resolve([])
    );
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockImplementation(({ headShas: [headSha] }) =>
      Promise.resolve(headSha === "X" ? [{ number: 8, title: "invalid title", headSha, draft: false }] : [])
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phases(sweep, recovery, recoveryStatus)).execute(
        command({ fallbackHeadSha: "F" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_lookup_failed" });

    expect(normal.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "X", state: "success" }),
      expect.any(AbortSignal)
    );
    expect(vi.mocked(recovery.listOpenPullRequestsForHeadShas).mock.calls.map(([input]) => input.headShas[0])).toEqual([
      "Y",
      "Y",
      "F",
      "F",
      "X",
      "X",
    ]);
    expect(recovery.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "X", state: "failure" }),
      expect.any(AbortSignal)
    );
  });

  it("recovery の確認中に head が変われば、新しい head を旧 head の再投稿より先に処理する", async () => {
    const normal = createGateway({ states: [pullRequestState("invalid title", "A")] });
    const recovery = createGateway({
      states: [pullRequestState("invalid title", "A"), pullRequestState("invalid title", "B")],
    });
    const recoveryStatus = createGateway();
    vi.mocked(normal.setTitleStatus).mockRejectedValueOnce(new Error("response lost"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(
        normal,
        () => 42,
        phases(createGateway(), recovery, recoveryStatus)
      ).execute(command({ fallbackHeadSha: "A" }), new AbortController().signal)
    ).rejects.toMatchObject({ stage: "status_failed" });

    expect(
      vi
        .mocked(recovery.setTitleStatus)
        .mock.calls.map(([status]) => status.sha)
        .slice(0, 2)
    ).toEqual(["A", "B"]);
    expect(recoveryStatus.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "A", state: "error" }),
      expect.any(AbortSignal)
    );
  });

  it("投稿の応答が失われ再判定も失敗した SHA を error で保護する", async () => {
    const normal = createGateway({ states: [pullRequestState("feat: current", "X")] });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const sweep = createGateway();
    vi.mocked(normal.setTitleStatus).mockRejectedValueOnce(new Error("response lost"));
    vi.mocked(recovery.getCurrentPolicyState).mockRejectedValue(new Error("lookup failed"));
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockRejectedValue(new Error("lookup failed"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phases(sweep, recovery, recoveryStatus)).execute(
        command({ fallbackHeadSha: "X" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "status_failed" });

    const posted = vi.mocked(normal.setTitleStatus).mock.calls.map(([input]) => input.sha);
    const protectedShas = vi
      .mocked(recoveryStatus.setTitleStatus)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.state === "error")
      .map((input) => input.sha);
    expect(posted).toEqual(["X"]);
    expect(posted.every((sha) => protectedShas.includes(sha))).toBe(true);
  });

  it("identity 検証失敗時は現在 head を優先し、既知の旧 SHA も保護する", async () => {
    const normal = createGateway({ states: [pullRequestState("feat: current", "new-sha")] });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    const sweep = createGateway();
    vi.mocked(normal.getAuthenticatedAppBotUserId).mockRejectedValue(new Error("identity failed"));
    vi.mocked(recoveryStatus.setTitleStatus).mockRejectedValueOnce(new Error("status failed"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phases(sweep, recovery, recoveryStatus)).execute(
        command({ previousHeadSha: "old-sha" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "identity_validation_failed" });
    expect(vi.mocked(recoveryStatus.setTitleStatus).mock.calls.map(([input]) => [input.sha, input.retry])).toEqual([
      ["new-sha", true],
      ["abc123", false],
      ["old-sha", false],
    ]);
  });

  it("sweep の操作に専用 gateway を使う", async () => {
    const normal = createGateway();
    const sweep = createGateway({ commitStatuses: [commitStatus("old-sha")] });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phases(sweep, recovery, recoveryStatus)).execute(
      command(),
      new AbortController().signal
    );
    expect(normal.listPullRequestCommitTitleStatuses).not.toHaveBeenCalled();
    expect(sweep.listPullRequestCommitTitleStatuses).toHaveBeenCalledTimes(1);
    expect(sweep.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "old-sha" }),
      expect.any(AbortSignal)
    );
  });

  it("同じ SHA を共有する別の open PR の title が無効なら、コメントせず status を failure にする", async () => {
    const gateway = createGateway({
      associatedStates: [
        [
          { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
          { number: 8, title: "feat: Add admin", headSha: "abc123", draft: false },
          { number: 9, title: "fix: Reject expired session", headSha: "abc123", draft: false },
        ],
      ],
    });
    const useCase = new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway));

    await expect(useCase.execute(command(), new AbortController().signal)).resolves.toEqual({
      result: "blocked_shared_head",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 0,
      supersededSweepFailed: false,
    });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failure",
        sha: "abc123",
        description: "PR #8, #9 のタイトルを修正する必要があります",
      }),
      expect.any(AbortSignal)
    );
    expect(gateway.createIssueComment).not.toHaveBeenCalled();
  });

  it("head SHA を共有する open PR の title がすべて有効なら success を投稿する", async () => {
    const gateway = createGateway({
      associatedStates: [
        [
          { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
          { number: 8, title: "fix: reject expired session", headSha: "abc123", draft: false },
        ],
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "valid" });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "success", sha: "abc123" }),
      expect.any(AbortSignal)
    );
  });

  it("確認中に共有 PR の title が変わったら、投稿済みの success を failure へ置き換える", async () => {
    const validSharedState = [
      { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
      { number: 8, title: "fix: reject expired session", headSha: "abc123", draft: false },
    ];
    const invalidSharedState = [
      { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
      { number: 8, title: "fix: Reject expired session", headSha: "abc123", draft: false },
    ];
    const gateway = createGateway({ associatedStates: [validSharedState, invalidSharedState] });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "blocked_shared_head" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "failure",
    ]);
  });

  it("open PR の集約が一度失敗しても、hard deadline 内の再取得で status を収束させる", async () => {
    const gateway = createGateway();
    const aggregationError = new Error("open PR lookup failed");
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockRejectedValueOnce(aggregationError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_lookup_failed", cause: aggregationError });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual(["success"]);
  });

  it("関連一覧を確定できなければ全走査で共有 head の無効な PR を判定する", async () => {
    const gateway = createGateway();
    const current = validState();
    vi.mocked(gateway.getCurrentPolicyState).mockResolvedValue({
      current,
      associatedPullRequests: undefined,
    });
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockResolvedValue([
      { number: 7, title: current.title, headSha: current.headSha, draft: false },
      { number: 8, title: "invalid title", headSha: current.headSha, draft: false },
    ]);
    const result = await new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
      command(),
      new AbortController().signal
    );
    expect(result.result).toBe("blocked_shared_head");
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "abc123", state: "failure" }),
      expect.any(AbortSignal)
    );
  });

  it("関連一覧と全 open PR 走査が失敗した場合も、取得済みの現在 head を復旧する", async () => {
    const gateway = createGateway({ states: [pullRequestState("feat: current", "new-sha")] });
    const failure = new Error("scan failed");
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockRejectedValueOnce(failure);
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockRejectedValue(new Error("recovery failed"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_lookup_failed", cause: failure });
    expect(gateway.listOpenPullRequestsForHeadShas).toHaveBeenCalledWith(
      expect.objectContaining({ headShas: ["new-sha"] }),
      expect.any(AbortSignal)
    );
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "new-sha", state: "error" }),
      expect.any(AbortSignal)
    );
  });

  it("現在の PR が closed なら自身の失敗コメントを削除し、残る共有 PR で status を更新する", async () => {
    const gateway = createGateway({
      comments: [comment(9, 42)],
      states: [pullRequestState("feat: Add login", "abc123", "closed")],
      associatedStates: [[{ number: 8, title: "fix: keep valid PR", headSha: "abc123", draft: false }]],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "closed", commentsDeleted: 1 });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "success", sha: "abc123" }),
      expect.any(AbortSignal)
    );
    expect(gateway.createIssueComment).not.toHaveBeenCalled();
    expect(gateway.deleteIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 9 }),
      expect.any(AbortSignal)
    );
  });

  it("closed PR のコメント削除が失敗しても共有 head の verdict を維持する", async () => {
    const sharedOpenPullRequest = {
      number: 8,
      title: "fix: keep valid PR",
      headSha: "abc123",
      draft: false,
    };
    const gateway = createGateway({
      comments: [comment(9, 42)],
      states: [pullRequestState("feat: Add login", "abc123", "closed")],
      associatedStates: [[sharedOpenPullRequest]],
    });
    const commentError = new Error("comment deletion failed");
    vi.mocked(gateway.deleteIssueComment).mockRejectedValueOnce(commentError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "comment_sync_failed", cause: commentError });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "success",
    ]);
  });

  it("その SHA の最後の open PR が closed になったら status を success へ戻す", async () => {
    const gateway = createGateway({
      states: [pullRequestState("feat: add login", "abc123", "closed")],
      associatedStates: [[]],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "closed" });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "success",
        sha: "abc123",
        description: "関連する open PR が見つかりませんでした",
      }),
      expect.any(AbortSignal)
    );
  });

  it("head から外れた not_success だけを success へ戻し、各 safety guard を維持する", async () => {
    const gateway = createGateway({
      commitStatuses: [
        commitStatus("old-1"),
        commitStatus("old-2", { statusState: "not_success" }),
        commitStatus("abc123"),
        commitStatus("never-validated", { statusState: null }),
        commitStatus("already-clean", { statusState: "success" }),
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toEqual({
      result: "valid",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 2,
      supersededSweepFailed: false,
    });

    const swept = vi
      .mocked(gateway.setTitleStatus)
      .mock.calls.filter(([status]) => status.description === "PR の最新 commit ではありません")
      .map(([status]) => status.sha);
    expect(swept).toEqual(["old-1", "old-2"]);
  });

  it("事前判定で open PR の head と比較未確定の SHA を掃除しない", async () => {
    const normal = createGateway();
    const sweep = createGateway({
      commitStatuses: [commitStatus("shared"), commitStatus("unknown"), commitStatus("safe")],
    });
    const shared = { number: 8, title: "invalid title", headSha: "shared", draft: false };
    vi.mocked(sweep.confirmSweepCommits).mockImplementation(({ shas }) =>
      Promise.resolve(
        new Map(shas.map((sha) => [sha, sha === "shared" ? [shared] : sha === "unknown" ? undefined : []]))
      )
    );

    const phaseGateways = phases(sweep);
    await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phaseGateways).execute(
      command(),
      new AbortController().signal
    );

    expect(sweep.listOpenPullRequestsForHeadShas).not.toHaveBeenCalled();
    expect(phaseGateways.log).toHaveBeenCalledWith("superseded_comparison_skipped", 1);
    expect(vi.mocked(sweep.setTitleStatus).mock.calls.map(([status]) => status.sha)).toEqual(["safe"]);
  });

  it("読み取り後に head へ復帰した commit は verdict を投稿し直す", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listPullRequestCommitTitleStatuses).mockResolvedValue([commitStatus("revived")]);
    vi.mocked(gateway.confirmSweepCommits)
      .mockResolvedValueOnce(new Map([["revived", []]]))
      .mockResolvedValue(new Map([["revived", [{ number: 9, title: "bad title", headSha: "revived", draft: false }]]]));
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockImplementation((request) =>
      Promise.resolve(
        request.headShas.includes("revived")
          ? [{ number: 9, title: "bad title", headSha: "revived", draft: false }]
          : [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "valid" });

    // 掃除で success を書いたあと、head へ戻っていることを検知して failure を投稿し直す
    const revivedWrites = vi
      .mocked(gateway.setTitleStatus)
      .mock.calls.filter(([status]) => status.sha === "revived")
      .map(([status]) => status.state);
    expect(revivedWrites).toEqual(["success", "failure"]);
  });

  it("掃除の一部だけ書き込みに失敗したら、成功件数と失敗状態を両方返す", async () => {
    const gateway = createGateway({ commitStatuses: [commitStatus("old-1"), commitStatus("old-2")] });
    vi.mocked(gateway.setTitleStatus).mockImplementation((status) =>
      status.sha === "old-2" ? Promise.reject(new Error("status write failed")) : Promise.resolve()
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toEqual({
      result: "valid",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 1,
      supersededSweepFailed: true,
      supersededSweepError: new TitleValidationExecutionError("status_failed", new Error("status write failed")),
    });
  });

  it("掃除の書き込み後の確認に失敗しても、成功済み件数を保持する", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listPullRequestCommitTitleStatuses).mockResolvedValue([
      commitStatus("old-1"),
      commitStatus("old-2"),
    ]);
    vi.mocked(gateway.confirmSweepCommits)
      .mockResolvedValueOnce(
        new Map([
          ["old-1", []],
          ["old-2", []],
        ])
      )
      .mockRejectedValue(new Error("confirmation failed"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toEqual({
      result: "valid",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 2,
      supersededSweepFailed: true,
      supersededSweepError: new Error("confirmation failed"),
    });
  });

  it("応答を失った書き込みも一括確認し、確認不能なら recovery の投稿枠で error にする", async () => {
    const normal = createGateway();
    const sweep = createGateway({ commitStatuses: [commitStatus("old-1"), commitStatus("old-2")] });
    const recovery = createGateway();
    const recoveryStatus = createGateway();
    vi.mocked(sweep.setTitleStatus).mockRejectedValueOnce(new Error("response lost"));
    vi.mocked(sweep.confirmSweepCommits)
      .mockResolvedValueOnce(
        new Map([
          ["old-1", []],
          ["old-2", []],
        ])
      )
      .mockResolvedValue(
        new Map([
          ["old-1", undefined],
          ["old-2", undefined],
        ])
      );
    vi.mocked(sweep.listOpenPullRequestsForHeadShas).mockRejectedValue(new Error("scan failed"));
    const result = await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      ...phases(sweep, recovery, recoveryStatus),
    }).execute(command(), new AbortController().signal);
    expect(result).toMatchObject({ result: "valid", supersededSweepFailed: true });
    expect(sweep.confirmSweepCommits).toHaveBeenCalledWith(
      expect.objectContaining({ shas: ["old-1", "old-2"] }),
      expect.any(AbortSignal)
    );
    expect(recoveryStatus.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "old-1", state: "error" }),
      expect.any(AbortSignal)
    );
    expect(recovery.setTitleStatus).not.toHaveBeenCalled();
  });

  it("書き込みと確認と修復の枠が足りなければ書かない", async () => {
    const normal = createGateway();
    const sweep = createGateway({ commitStatuses: [commitStatus("old")] });
    const phaseGateways = phases(sweep);
    phaseGateways.budget.remaining.mockReturnValue(4);
    const result = await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      ...phaseGateways,
    }).execute(command(), new AbortController().signal);
    expect(result).toMatchObject({ result: "valid", supersededSweepFailed: false });
    expect(sweep.setTitleStatus).not.toHaveBeenCalled();
    expect(phaseGateways.log).toHaveBeenCalledWith("superseded_sweep_budget_exhausted", 1);
  });

  it("確認時に default branch 上なら書き直し後も全 open PR と照合する", async () => {
    const normal = createGateway();
    const sweep = createGateway({ commitStatuses: [commitStatus("old")] });
    const recovery = createGateway();
    const shared = [{ number: 9, title: "bad title", headSha: "old", draft: false }];
    for (const gateway of [sweep, recovery]) {
      vi.mocked(gateway.confirmSweepCommits).mockResolvedValue(new Map([["old", undefined]]));
      vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockResolvedValue(shared);
    }
    vi.mocked(sweep.confirmSweepCommits).mockResolvedValueOnce(new Map([["old", []]]));
    await new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, {
      ...phases(sweep, recovery),
    }).execute(command(), new AbortController().signal);
    expect(sweep.listOpenPullRequestsForHeadShas).toHaveBeenCalledTimes(1);
    expect(recovery.listOpenPullRequestsForHeadShas).toHaveBeenCalledTimes(1);
    expect(sweep.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "old", state: "failure" }),
      expect.any(AbortSignal)
    );
  });

  it("掃除に失敗しても検証結果は返す", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listPullRequestCommitTitleStatuses).mockRejectedValue(new Error("graphql down"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toEqual({
      result: "valid",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 0,
      supersededSweepFailed: true,
      supersededSweepError: new Error("graphql down"),
    });
  });

  it("synchronize の previous SHA を、現在の SHA を検証する前に処理する", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockImplementation((request) =>
      Promise.resolve(
        request.headShas.includes("old-sha")
          ? [{ number: 8, title: "fix: Invalid old shared PR", headSha: "old-sha", draft: false }]
          : [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        { ...command(), previousHeadSha: "old-sha" },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "valid" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => [status.sha, status.state])).toEqual([
      ["old-sha", "failure"],
      ["abc123", "success"],
    ]);
  });

  it("open PR が無くなった previous SHA の status は success へ戻す", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockImplementation((request) =>
      Promise.resolve(
        request.headShas.includes("old-sha")
          ? []
          : [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        { ...command(), previousHeadSha: "old-sha" },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "valid" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => [status.sha, status.state])).toEqual([
      ["old-sha", "success"],
      ["abc123", "success"],
    ]);
    expect(vi.mocked(gateway.setTitleStatus).mock.calls[0]?.[0].description).toBe("PR の最新 commit ではありません");
  });

  it("現在の PR の SHA と異なる webhook の SHA も個別に検証して check を投稿する", async () => {
    const gateway = createGateway({ states: [pullRequestState("feat: add login", "current-sha")] });
    vi.mocked(gateway.listOpenPullRequestsForHeadShas).mockImplementation((request) =>
      Promise.resolve(
        request.headShas.includes("webhook-sha")
          ? [{ number: 8, title: "fix: Invalid shared title", headSha: "webhook-sha", draft: false }]
          : [{ number: 7, title: "feat: add login", headSha: "current-sha", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command({ fallbackHeadSha: "webhook-sha" }),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "valid" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => [status.sha, status.state])).toEqual([
      ["webhook-sha", "failure"],
      ["current-sha", "success"],
    ]);
  });

  it("現在の title が無効なら失敗コメントを 1 件だけ作成する", async () => {
    const gateway = createGateway({
      comments: [comment(3, 99)],
      states: [pullRequestState("feat: Add login", "current-sha")],
    });
    const useCase = new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway));

    await expect(
      useCase.execute(command({ fallbackHeadSha: "current-sha" }), new AbortController().signal)
    ).resolves.toMatchObject({
      result: "invalid",
      comment: "created",
    });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failure",
        sha: "current-sha",
        description: "PR #7 のタイトルを修正する必要があります",
      }),
      expect.any(AbortSignal)
    );
    expect(gateway.createIssueComment).toHaveBeenCalledOnce();
    const [createdInput, createdSignal] = vi.mocked(gateway.createIssueComment).mock.calls[0] ?? [];
    expect(createdInput?.body).toContain("feat: Add login");
    expect(createdInput?.body).toContain(PR_TITLE_COMMENT_MARKER);
    expect(createdSignal).toBeInstanceOf(AbortSignal);
  });

  it("処理中に PR が変わったら、最新の状態で check とコメントを作り直す", async () => {
    const gateway = createGateway({
      states: [
        pullRequestState("feat: add login", "same-sha"),
        pullRequestState("feat: Add login", "same-sha"),
        pullRequestState("feat: Add login", "same-sha"),
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command({ fallbackHeadSha: "same-sha" }),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "invalid", comment: "created" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "failure",
    ]);
    expect(gateway.getCurrentPolicyState).toHaveBeenCalledTimes(4);
  });

  it("コメント同期が失敗しても、既知の SHA を現在の verdict へ戻してから error にする", async () => {
    const gateway = createGateway({
      states: [
        pullRequestState("feat: add login", "same-sha"),
        pullRequestState("feat: Add login", "same-sha"),
        pullRequestState("feat: Add login", "same-sha"),
      ],
    });
    const commentError = new Error("comment request failed");
    vi.mocked(gateway.listIssueComments).mockRejectedValue(commentError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command({ fallbackHeadSha: "same-sha" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "comment_sync_failed", cause: commentError });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "failure",
      "failure",
    ]);
  });

  it("success の投稿後に状態の再確認が一度失敗しても、共有状態の再取得で success へ戻す", async () => {
    const gateway = createGateway();
    const stateLookupError = new Error("confirmation failed");
    vi.mocked(gateway.getCurrentPolicyState)
      .mockResolvedValueOnce({
        current: validState(),
        associatedPullRequests: undefined,
      })
      .mockRejectedValueOnce(stateLookupError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_lookup_failed", cause: stateLookupError });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "success",
    ]);
  });

  it("success の書き込みが成否不明で失敗したら、共有状態を再取得して success を再投稿する", async () => {
    const gateway = createGateway();
    const ambiguousWriteError = new Error("response lost after write");
    vi.mocked(gateway.setTitleStatus).mockRejectedValueOnce(ambiguousWriteError).mockResolvedValueOnce(undefined);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "status_failed", cause: ambiguousWriteError });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "success",
    ]);
  });

  it("success の後に通常処理の deadline へ達したら、予約した signal で success へ再収束させる", async () => {
    const gateway = createGateway();
    const operationController = new AbortController();
    const cleanupController = new AbortController();
    vi.mocked(gateway.setTitleStatus)
      .mockImplementationOnce(() => {
        operationController.abort(new Error("operation deadline"));
        return Promise.resolve();
      })
      .mockResolvedValueOnce(undefined);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        operationController.signal,
        cleanupController.signal
      )
    ).rejects.toMatchObject({ stage: "state_lookup_failed" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "success",
    ]);
    expect(vi.mocked(gateway.setTitleStatus).mock.calls[1]?.[1]).toBe(cleanupController.signal);
  });

  it("PR が変わり続けるときは success を記録せず state_changed で失敗する", async () => {
    const gateway = createGateway({
      states: [
        pullRequestState("feat: first title", "sha-1"),
        pullRequestState("feat: second title", "sha-2"),
        pullRequestState("feat: third title", "sha-3"),
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command({ fallbackHeadSha: "sha-1" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_changed", cause: { code: "PULL_REQUEST_STATE_CHANGED" } });
  });

  it("旧 SHA が収束しないときも現在 head を優先して再判定する", async () => {
    const normal = createGateway({ states: [pullRequestState("feat: Invalid title", "current-sha")] });
    const recovery = createGateway({ states: [pullRequestState("feat: Invalid title", "current-sha")] });
    const recoveryStatus = createGateway();
    const sweep = createGateway();
    const invalidOldPullRequest = { number: 8, title: "feat: Invalid title", headSha: "old-sha", draft: false };
    vi.mocked(normal.listOpenPullRequestsForHeadShas).mockResolvedValue([]);
    vi.mocked(normal.listOpenPullRequestsForHeadShas)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([invalidOldPullRequest])
      .mockResolvedValueOnce([]);
    vi.mocked(recovery.listOpenPullRequestsForHeadShas).mockResolvedValue([]);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phases(sweep, recovery, recoveryStatus)).execute(
        command({ fallbackHeadSha: "old-sha" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_changed" });
    expect(vi.mocked(normal.setTitleStatus).mock.calls.map(([status]) => [status.sha, status.state])).toEqual([
      ["old-sha", "success"],
      ["old-sha", "failure"],
      ["old-sha", "error"],
    ]);
    expect(recovery.getCurrentPolicyState).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: "current-sha" }),
      expect.any(AbortSignal)
    );
    expect(recovery.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "current-sha", state: "failure" }),
      expect.any(AbortSignal)
    );
    expect(recoveryStatus.setTitleStatus).not.toHaveBeenCalled();
  });

  it("recovery 中に保護済みの旧 SHA へ戻っても error を上書きしない", async () => {
    const normal = createGateway({ states: [pullRequestState("feat: Invalid title", "current-sha")] });
    const recovery = createGateway({ states: [pullRequestState("feat: valid title", "old-sha")] });
    const recoveryStatus = createGateway();
    const sweep = createGateway();
    vi.mocked(normal.listOpenPullRequestsForHeadShas).mockResolvedValue([]);
    vi.mocked(normal.listOpenPullRequestsForHeadShas)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ number: 8, title: "invalid title", headSha: "old-sha", draft: false }])
      .mockResolvedValueOnce([]);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(normal, () => 42, phases(sweep, recovery, recoveryStatus)).execute(
        command({ fallbackHeadSha: "old-sha" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_changed" });
    expect(normal.setTitleStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha: "old-sha", state: "error" }),
      expect.any(AbortSignal)
    );
    expect(recovery.setTitleStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ sha: "old-sha" }),
      expect.any(AbortSignal)
    );
  });

  it("初回の状態取得が失敗したら、署名済み webhook の SHA へ error status を投稿する", async () => {
    const gateway = createGateway();
    const stateLookupError = new Error("initial lookup failed");
    const cleanupController = new AbortController();
    vi.mocked(gateway.getCurrentPolicyState).mockRejectedValueOnce(stateLookupError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command({ fallbackHeadSha: "webhook-sha" }),
        new AbortController().signal,
        cleanupController.signal
      )
    ).rejects.toMatchObject({ stage: "state_lookup_failed", cause: stateLookupError });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "webhook-sha", state: "error" }),
      cleanupController.signal
    );
  });

  it("App identity の取得が失敗したら、取得済みの SHA へ error status を投稿する", async () => {
    const gateway = createGateway();
    const identityError = new Error("identity lookup failed");
    vi.mocked(gateway.getAuthenticatedAppBotUserId).mockRejectedValueOnce(identityError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "identity_validation_failed", cause: identityError });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "abc123", state: "error" }),
      expect.any(AbortSignal)
    );
  });

  it("設定した Bot user ID が不正なら error status を投稿して fail-closed にする", async () => {
    const gateway = createGateway();
    const configurationError = new ConfigurationError("GITHUB_APP_BOT_USER_ID", "invalid");

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(
        gateway,
        () => {
          throw configurationError;
        },
        phases(gateway)
      ).execute(command(), new AbortController().signal)
    ).rejects.toMatchObject({ stage: "identity_validation_failed", cause: configurationError });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "abc123", state: "error" }),
      expect.any(AbortSignal)
    );
  });

  it("設定した bot ID が別の account のものなら、コメントを操作する前に fail-closed にする", async () => {
    const gateway = createGateway({ authenticatedAppBotUserId: 99, comments: [comment(1, 42)] });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      stage: "identity_validation_failed",
      cause: { configKey: "GITHUB_APP_BOT_USER_ID", reason: "invalid" },
    });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "abc123", state: "error" }),
      expect.any(AbortSignal)
    );
    expect(gateway.listIssueComments).not.toHaveBeenCalled();
    expect(gateway.updateIssueComment).not.toHaveBeenCalled();
    expect(gateway.deleteIssueComment).not.toHaveBeenCalled();
  });

  it("status の投稿が失敗したら、コメント同期へ進まずに失敗する", async () => {
    const gateway = createGateway();
    const checkRunError = new Error("check run failed");
    vi.mocked(gateway.setTitleStatus).mockRejectedValue(checkRunError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      stage: "status_failed",
      cause: checkRunError,
    });
    expect(gateway.listIssueComments).not.toHaveBeenCalled();
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "success",
      "error",
    ]);
  });

  it("draft PR は検証を保留し、draft 用のコメントを出す", async () => {
    const gateway = createGateway({ states: [pullRequestState("feat: Add login", "abc123", "open", true)] });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ comment: "created" });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "pending", description: "draft のため検証を保留しています" }),
      expect.any(AbortSignal)
    );
    const body = vi.mocked(gateway.createIssueComment).mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("Ready for review の前にタイトルを修正してください");
    expect(body).not.toContain("## Pull Request のタイトルを修正してください");
  });

  it("draft PR のタイトルが有効ならコメントを出さない", async () => {
    const gateway = createGateway({ states: [pullRequestState("feat: add login", "abc123", "open", true)] });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ comment: "none" });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "pending" }),
      expect.any(AbortSignal)
    );
    expect(gateway.createIssueComment).not.toHaveBeenCalled();
  });

  it("作業中の接頭辞が付いたタイトルは保留の status とコメントにする", async () => {
    const gateway = createGateway({ states: [pullRequestState("[WIP] feat: add login", "abc123")] });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "held", comment: "created" });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        description: "作業中の接頭辞が付いているため検証を保留しています",
      }),
      expect.any(AbortSignal)
    );
    expect(vi.mocked(gateway.createIssueComment).mock.calls[0]?.[0].body).toContain(
      "## この Pull Request はまだ作業中です"
    );
  });

  it("接頭辞が付いた PR は draft と違い gate に残し、共有 head を pending で止める", async () => {
    const gateway = createGateway({
      associatedStates: [
        [
          // 自分のタイトルは有効
          // 接頭辞付きの PR#8 は merge できてしまうので gate から外さない
          { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
          { number: 8, title: "WIP: add admin", headSha: "abc123", draft: false },
        ],
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "held", comment: "none" });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        description: "作業中の接頭辞が付いているため検証を保留しています",
      }),
      expect.any(AbortSignal)
    );
    expect(gateway.createIssueComment).not.toHaveBeenCalled();
  });

  it("接頭辞と無効なタイトルが混在する head では、修正が要る failure を優先する", async () => {
    const gateway = createGateway({
      associatedStates: [
        [
          { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
          { number: 8, title: "WIP: add admin", headSha: "abc123", draft: false },
          { number: 9, title: "feat: Add report", headSha: "abc123", draft: false },
        ],
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "blocked_shared_head" });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failure",
        description: "PR #9 のタイトルを修正する必要があります",
      }),
      expect.any(AbortSignal)
    );
  });

  it("draft が解除されたことを確認で検出したら、status を投稿し直す", async () => {
    const gateway = createGateway({
      states: [
        pullRequestState("feat: Add login", "abc123", "open", true),
        pullRequestState("feat: Add login", "abc123", "open", false),
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "invalid", comment: "created" });
    // draft を比較しないと 1 回目の pending で収束したと判断し、無効なタイトルが保留のまま残る
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "pending",
      "failure",
    ]);
  });

  it("共有 PR の draft が解除されたことを確認で検出したら、success を failure へ置き換える", async () => {
    const draftShared = [
      { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
      { number: 8, title: "feat: Add admin", headSha: "abc123", draft: true },
    ];
    const readyShared = [
      { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
      { number: 8, title: "feat: Add admin", headSha: "abc123", draft: false },
    ];
    const gateway = createGateway({ associatedStates: [draftShared, readyShared] });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
        command(),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "blocked_shared_head" });
    // draft を比較しないと success のまま収束し、無効なタイトルの PR が merge できてしまう
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "failure",
    ]);
  });

  it("draft PR で接頭辞も付いているときは draft を優先する", async () => {
    const gateway = createGateway({ states: [pullRequestState("WIP: add login", "abc123", "open", true)] });

    await new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
      command(),
      new AbortController().signal
    );

    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "pending", description: "draft のため検証を保留しています" }),
      expect.any(AbortSignal)
    );
    expect(vi.mocked(gateway.createIssueComment).mock.calls[0]?.[0].body).toContain(
      "Ready for review の前にタイトルを修正してください"
    );
  });

  it("同じ head の open PR がすべて draft のときだけ pending にする", async () => {
    const allDraft = createGateway({
      states: [pullRequestState("feat: Add login", "abc123", "open", true)],
      associatedStates: [
        [
          { number: 7, title: "feat: Add login", headSha: "abc123", draft: true },
          { number: 8, title: "feat: Add admin", headSha: "abc123", draft: true },
        ],
      ],
    });

    await new ValidatePullRequestTitleUseCaseImpl(allDraft, () => 42, phases(allDraft)).execute(
      command(),
      new AbortController().signal
    );

    expect(allDraft.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "pending" }),
      expect.any(AbortSignal)
    );
  });

  it("draft ではない PR が同じ head に居れば、その PR のタイトルで判定する", async () => {
    const gateway = createGateway({
      states: [pullRequestState("feat: Add login", "abc123", "open", true)],
      associatedStates: [
        [
          // 自分は draft で無効
          // gate は draft でない PR#8 の有効なタイトルで決まる
          { number: 7, title: "feat: Add login", headSha: "abc123", draft: true },
          { number: 8, title: "fix: reject expired session", headSha: "abc123", draft: false },
        ],
      ],
    });

    await new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42, phases(gateway)).execute(
      command(),
      new AbortController().signal
    );

    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "success", description: "タイトルに問題はありません" }),
      expect.any(AbortSignal)
    );
  });
});
