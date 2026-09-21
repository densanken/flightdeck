import { describe, expect, it, vi } from "vitest";

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
  isOpenPullRequestHead: false,
  associatedPullRequestsTruncated: false,
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
  const getCurrentPullRequestTitleState: TitleValidationGateway["getCurrentPullRequestTitleState"] = (
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
  const listOpenPullRequestsForHeadSha: TitleValidationGateway["listOpenPullRequestsForHeadSha"] = (
    request,
    signal
  ) => {
    if (signal.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    }
    if (input.associatedStates) {
      const associated = input.associatedStates[Math.min(associatedStateIndex, input.associatedStates.length - 1)];
      associatedStateIndex += 1;
      return associated ? Promise.resolve(associated) : Promise.reject(new Error("Missing associated test state"));
    }
    return Promise.resolve(
      lastState.state === "open" && lastState.headSha === request.headSha
        ? [{ number: 7, title: lastState.title, headSha: lastState.headSha, draft: false }]
        : []
    );
  };
  return {
    getCurrentPullRequestTitleState: vi.fn(getCurrentPullRequestTitleState),
    listOpenPullRequestsForHeadSha: vi.fn(listOpenPullRequestsForHeadSha),
    getAuthenticatedAppBotUserId: vi.fn().mockResolvedValue(input.authenticatedAppBotUserId ?? 42),
    listPullRequestCommitTitleStatuses: vi.fn().mockResolvedValue(input.commitStatuses ?? []),
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
};

describe("ValidatePullRequestTitleUseCaseImpl", () => {
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
    const useCase = new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42);

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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).resolves.toMatchObject({ result: "blocked_shared_head" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "failure",
    ]);
  });

  it("open PR の集約が一度失敗しても、hard deadline 内の再取得で status を収束させる", async () => {
    const gateway = createGateway();
    const aggregationError = new Error("open PR lookup failed");
    vi.mocked(gateway.listOpenPullRequestsForHeadSha).mockRejectedValueOnce(aggregationError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).rejects.toMatchObject({ stage: "state_lookup_failed", cause: aggregationError });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual(["success"]);
  });

  it("現在の PR が closed なら自身の失敗コメントを削除し、残る共有 PR で status を更新する", async () => {
    const gateway = createGateway({
      comments: [comment(9, 42)],
      states: [pullRequestState("feat: Add login", "abc123", "closed")],
      associatedStates: [[{ number: 8, title: "fix: keep valid PR", headSha: "abc123", draft: false }]],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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

  it("closed PR のコメント削除が失敗しても、共有 SHA の open PR を error にしない", async () => {
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
        commitStatus("other-pr-head", { isOpenPullRequestHead: true }),
        commitStatus("too-many-prs", { associatedPullRequestsTruncated: true }),
      ],
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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

  it("読み取り後に head へ復帰した commit は verdict を投稿し直す", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listPullRequestCommitTitleStatuses)
      .mockResolvedValueOnce([commitStatus("revived")])
      .mockResolvedValue([commitStatus("revived", { isOpenPullRequestHead: true })]);
    vi.mocked(gateway.listOpenPullRequestsForHeadSha).mockImplementation((request) =>
      Promise.resolve(
        request.headSha === "revived"
          ? [{ number: 9, title: "bad title", headSha: "revived", draft: false }]
          : [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).resolves.toMatchObject({ result: "valid" });

    // 掃除で success を書いたあと、head へ戻っていることを検知して failure を投稿し直す
    const revivedWrites = vi
      .mocked(gateway.setTitleStatus)
      .mock.calls.filter(([status]) => status.sha === "revived")
      .map(([status]) => status.state);
    expect(revivedWrites).toEqual(["success", "failure"]);
  });

  it("掃除の書き込みは 1 delivery あたり 20 件までにする", async () => {
    const gateway = createGateway({
      commitStatuses: Array.from({ length: 25 }, (_unused, index) => commitStatus(`old-${String(index)}`)),
    });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).resolves.toMatchObject({ supersededStatusesCleared: 20 });
  });

  it("掃除の一部だけ書き込みに失敗したら、成功件数と失敗状態を両方返す", async () => {
    const gateway = createGateway({ commitStatuses: [commitStatus("old-1"), commitStatus("old-2")] });
    vi.mocked(gateway.setTitleStatus).mockImplementation((status) =>
      status.sha === "old-2" ? Promise.reject(new Error("status write failed")) : Promise.resolve()
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).resolves.toEqual({
      result: "valid",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 1,
      supersededSweepFailed: true,
    });
  });

  it("掃除の書き込み後の確認に失敗しても、成功済み件数を保持する", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listPullRequestCommitTitleStatuses)
      .mockResolvedValueOnce([commitStatus("old-1"), commitStatus("old-2")])
      .mockRejectedValueOnce(new Error("confirmation failed"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).resolves.toEqual({
      result: "valid",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 2,
      supersededSweepFailed: true,
    });
  });

  it("掃除に失敗しても検証結果は返す", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listPullRequestCommitTitleStatuses).mockRejectedValue(new Error("graphql down"));

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).resolves.toEqual({
      result: "valid",
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
      supersededStatusesCleared: 0,
      supersededSweepFailed: true,
    });
  });

  it("synchronize の previous SHA を、現在の SHA を検証する前に処理する", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listOpenPullRequestsForHeadSha).mockImplementation((request) =>
      Promise.resolve(
        request.headSha === "old-sha"
          ? [{ number: 8, title: "fix: Invalid old shared PR", headSha: "old-sha", draft: false }]
          : [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
    vi.mocked(gateway.listOpenPullRequestsForHeadSha).mockImplementation((request) =>
      Promise.resolve(
        request.headSha === "old-sha" ? [] : [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
    vi.mocked(gateway.listOpenPullRequestsForHeadSha).mockImplementation((request) =>
      Promise.resolve(
        request.headSha === "webhook-sha"
          ? [{ number: 8, title: "fix: Invalid shared title", headSha: "webhook-sha", draft: false }]
          : [{ number: 7, title: "feat: add login", headSha: "current-sha", draft: false }]
      )
    );

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
    const useCase = new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42);

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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
        command({ fallbackHeadSha: "same-sha" }),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ result: "invalid", comment: "created" });
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "failure",
    ]);
    expect(gateway.getCurrentPullRequestTitleState).toHaveBeenCalledTimes(4);
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
    vi.mocked(gateway.getCurrentPullRequestTitleState)
      .mockResolvedValueOnce(validState())
      .mockRejectedValueOnce(stateLookupError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
        command({ fallbackHeadSha: "sha-1" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ stage: "state_changed", cause: { code: "PULL_REQUEST_STATE_CHANGED" } });
  });

  it("初回の状態取得が失敗したら、署名済み webhook の SHA へ error status を投稿する", async () => {
    const gateway = createGateway();
    const stateLookupError = new Error("initial lookup failed");
    const cleanupController = new AbortController();
    vi.mocked(gateway.getCurrentPullRequestTitleState).mockRejectedValueOnce(stateLookupError);

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => {
        throw configurationError;
      }).execute(command(), new AbortController().signal)
    ).rejects.toMatchObject({ stage: "identity_validation_failed", cause: configurationError });
    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "abc123", state: "error" }),
      expect.any(AbortSignal)
    );
  });

  it("設定した bot ID が別の account のものなら、コメントを操作する前に fail-closed にする", async () => {
    const gateway = createGateway({ authenticatedAppBotUserId: 99, comments: [comment(1, 42)] });

    await expect(
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
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
      new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
    ).resolves.toMatchObject({ result: "blocked_shared_head" });
    // draft を比較しないと success のまま収束し、無効なタイトルの PR が merge できてしまう
    expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
      "success",
      "failure",
    ]);
  });

  it("draft PR で接頭辞も付いているときは draft を優先する", async () => {
    const gateway = createGateway({ states: [pullRequestState("WIP: add login", "abc123", "open", true)] });

    await new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal);

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

    await new ValidatePullRequestTitleUseCaseImpl(allDraft, () => 42).execute(command(), new AbortController().signal);

    expect(allDraft.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "pending" }),
      expect.any(AbortSignal)
    );
  });

  describe("associatedPullRequestsCache の memo と invalidate", () => {
    it("同じ head SHA への複数回参照は memo で 1 回分の呼び出しに減る", async () => {
      // fallbackHeadSha (webhook-sha) は現在の head (current-sha) と別の SHA なので、
      // detached head として最初に読まれ、ループ末尾で memo が populate されたまま残る
      // その後 current-sha への postCurrentStatus の書き込みだけを失敗させ、
      // bestEffortReconcileKnownHeadStatuses が webhook-sha を再度たどっても、
      // 直前の memo が生きていれば 1 回分の listOpenPullRequestsForHeadSha 呼び出しを省略できるはず
      const gateway = createGateway({ states: [pullRequestState("feat: add login", "current-sha")] });
      vi.mocked(gateway.listOpenPullRequestsForHeadSha).mockImplementation((request) =>
        Promise.resolve(
          request.headSha === "webhook-sha"
            ? [{ number: 8, title: "feat: add admin", headSha: "webhook-sha", draft: false }]
            : [{ number: 7, title: "feat: add login", headSha: "current-sha", draft: false }]
        )
      );
      vi.mocked(gateway.setTitleStatus).mockImplementation((status) =>
        status.sha === "current-sha" ? Promise.reject(new Error("write failed")) : Promise.resolve()
      );

      await expect(
        new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
          command({ fallbackHeadSha: "webhook-sha" }),
          new AbortController().signal
        )
      ).rejects.toMatchObject({ stage: "status_failed" });

      // memo が効けば 3 回（初期処理の初回読み取り + 書き込み後の再取得 + best-effort での書き込み後の再取得）
      // memo が無ければ best-effort の最初の読み取りも実回数に加わり 4 回になる
      expect(
        vi
          .mocked(gateway.listOpenPullRequestsForHeadSha)
          .mock.calls.filter(([request]) => request.headSha === "webhook-sha").length
      ).toBe(3);
    });

    it("postStatus の書き込み後は invalidate され、直後の再取得が新しい読み取りになる", async () => {
      const gateway = createGateway({
        associatedStates: [[{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }]],
      });

      await expect(
        new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
      ).resolves.toMatchObject({ result: "valid" });

      // invalidate されていれば、初期読み取り・postCurrentStatus 後の再取得・
      // コメント同期後の再取得（clear() 経由）の 3 回とも実際の読み取りになる
      // postStatus の invalidate が無いと、postCurrentStatus 後の再取得が memo hit になり 2 回に減る
      expect(vi.mocked(gateway.listOpenPullRequestsForHeadSha).mock.calls.length).toBe(3);
    });

    it("postStatus は書き込みが失敗しても invalidate してから best-effort の再取得へ進む", async () => {
      // setTitleStatus を常に失敗させ、invalidate が「書き込み成功後」ではなく
      // 「書き込みを試みた時点」で必ず起きることを検証する
      // 成功後にしか invalidate しない実装だと、postCurrentStatus の書き込み失敗時に
      // memo が残ったままになり、bestEffortReconcileKnownHeadStatuses の再取得が memo hit する
      const gateway = createGateway();
      vi.mocked(gateway.setTitleStatus).mockRejectedValue(new Error("status write failed"));

      await expect(
        new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal)
      ).rejects.toMatchObject({ stage: "status_failed" });

      // 初期読み取りと、書き込み失敗後の best-effort 再取得の 2 回とも実読み取りになるはず
      expect(vi.mocked(gateway.listOpenPullRequestsForHeadSha).mock.calls.length).toBe(2);
    });

    it("reconcileTitleValidationComments の後は clear() され、確認の再取得が古い memo を再利用しない", async () => {
      const stableShared = [{ number: 7, title: "feat: add login", headSha: "abc123", draft: false }];
      const changedShared = [
        { number: 7, title: "feat: add login", headSha: "abc123", draft: false },
        { number: 8, title: "fix: Reject expired session", headSha: "abc123", draft: false },
      ];
      // index 0, 1 は stabilizeCurrentCheck 内の postStatus 経由の再取得までを安定させ、
      // index 2 はコメント同期後の再取得でだけ見える変化にする
      // 3 回目の呼び出しが clear() 経由の実読み取りにならず memo hit してしまうと、
      // この変化を検出できず success のまま誤って収束する
      const gateway = createGateway({ associatedStates: [stableShared, stableShared, changedShared] });

      const result = await new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
        command(),
        new AbortController().signal
      );

      expect(result).toMatchObject({ result: "blocked_shared_head" });
      expect(vi.mocked(gateway.setTitleStatus).mock.calls.map(([status]) => status.state)).toEqual([
        "success",
        "failure",
      ]);
    });

    it("clear() はコメント同期が失敗しても、現在 SHA 以外の memo もまとめて破棄する", async () => {
      // fallbackHeadSha (webhook-sha) は現在の head (current-sha) と別の SHA
      // detached head としての初期処理で先に読まれ、memo が populate されたまま残る
      // その後コメント同期を失敗させ、reconcileStableState が例外で抜けても
      // finally の clear() が「現在 SHA だけ」ではなく cache 全 entry を落とすことを検証する
      // current SHA だけを delete する実装に弱めても、この webhook-sha の memo は消えずに残ってしまう
      const gateway = createGateway({ states: [pullRequestState("feat: add login", "current-sha")] });
      vi.mocked(gateway.listOpenPullRequestsForHeadSha).mockImplementation((request) =>
        Promise.resolve(
          request.headSha === "webhook-sha"
            ? [{ number: 8, title: "feat: add admin", headSha: "webhook-sha", draft: false }]
            : [{ number: 7, title: "feat: add login", headSha: "current-sha", draft: false }]
        )
      );
      vi.mocked(gateway.listIssueComments).mockRejectedValue(new Error("comment list failed"));

      await expect(
        new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(
          command({ fallbackHeadSha: "webhook-sha" }),
          new AbortController().signal
        )
      ).rejects.toMatchObject({ stage: "comment_sync_failed" });

      // detached head 処理で 2 回（初期読み取り + postStatus 後の再取得）読んだ後、
      // clear() が全 entry を落としていれば best-effort の再処理でも同じ 2 回分（初期読み取り +
      // postStatus 後の再取得）を実読み取りし直し、計 4 回になる
      // clear() が current SHA だけを落とす実装だと、best-effort の再処理の初回読み取りが
      // memo hit してしまい 3 回に減る
      expect(
        vi
          .mocked(gateway.listOpenPullRequestsForHeadSha)
          .mock.calls.filter(([request]) => request.headSha === "webhook-sha").length
      ).toBe(4);
    });
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

    await new ValidatePullRequestTitleUseCaseImpl(gateway, () => 42).execute(command(), new AbortController().signal);

    expect(gateway.setTitleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "success", description: "タイトルに問題はありません" }),
      expect.any(AbortSignal)
    );
  });
});
