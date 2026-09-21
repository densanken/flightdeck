import { describe, expect, it, vi } from "vitest";

import { isCommentCreatedByThisApp, reconcileTitleValidationComments } from "./comment-reconciler.js";
import { buildTitleValidationFailureComment, PR_TITLE_COMMENT_MARKER } from "../../domain/title-comment.js";

import type { TitleValidationCommentGateway } from "./comment-reconciler.js";
import type { IssueComment } from "./dependencies.js";
import type { TitleValidationFailure } from "@flightdeck/pr-title";

const coordinates = { owner: "owner", repo: "repo", pullRequestNumber: 7 };
const failedValidation: TitleValidationFailure = {
  valid: false,
  reason: "invalid_description",
  title: "feat: Add login",
};
const signal = new AbortController().signal;

const comment = (
  id: number,
  userId: number,
  body: string | null = "### Pull Request のタイトルを修正してください\n\nold"
): IssueComment => ({
  id,
  body,
  user: { id: userId },
});

const createGateway = (initialComments: IssueComment[] = []): TitleValidationCommentGateway => {
  const comments = initialComments.map((candidate) => ({
    ...candidate,
    user: candidate.user ? { ...candidate.user } : null,
  }));
  let nextId = Math.max(0, ...comments.map((candidate) => candidate.id)) + 1;
  return {
    listIssueComments: vi.fn<TitleValidationCommentGateway["listIssueComments"]>(() =>
      Promise.resolve(
        comments.map((candidate) => ({ ...candidate, user: candidate.user ? { ...candidate.user } : null }))
      )
    ),
    createIssueComment: vi.fn<TitleValidationCommentGateway["createIssueComment"]>((input) => {
      comments.push(comment(nextId, 42, input.body));
      nextId += 1;
      return Promise.resolve();
    }),
    updateIssueComment: vi.fn<TitleValidationCommentGateway["updateIssueComment"]>((input) => {
      const existing = comments.find((candidate) => candidate.id === input.commentId);
      if (existing) existing.body = input.body;
      return Promise.resolve();
    }),
    deleteIssueComment: vi.fn<TitleValidationCommentGateway["deleteIssueComment"]>((input) => {
      const index = comments.findIndex((candidate) => candidate.id === input.commentId);
      if (index >= 0) comments.splice(index, 1);
      return Promise.resolve();
    }),
  };
};

describe("isCommentCreatedByThisApp", () => {
  it("本文や login ではなく数値の user ID だけで判定する", () => {
    expect(isCommentCreatedByThisApp(comment(1, 42, "anything"), 42)).toBe(true);
    expect(isCommentCreatedByThisApp(comment(1, 43, "same body"), 42)).toBe(false);
    expect(isCommentCreatedByThisApp({ id: 1, body: null, user: null }, 42)).toBe(false);
  });
});

describe("reconcileTitleValidationComments", () => {
  it("自身のコメントが無いときは失敗コメントを 1 件だけ作成する", async () => {
    const gateway = createGateway([comment(1, 99)]);
    const expectedBody = buildTitleValidationFailureComment(failedValidation);

    await expect(reconcileTitleValidationComments(gateway, coordinates, expectedBody, 42, signal)).resolves.toEqual({
      comment: "created",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
    });
    expect(gateway.createIssueComment).toHaveBeenCalledWith({ ...coordinates, body: expectedBody }, signal);
  });

  it("自身の最も古いコメントを残して更新し、重複するコメントを削除する", async () => {
    const gateway = createGateway([comment(20, 42), comment(10, 42), comment(1, 99)]);
    const expectedBody = buildTitleValidationFailureComment(failedValidation);

    await expect(reconcileTitleValidationComments(gateway, coordinates, expectedBody, 42, signal)).resolves.toEqual({
      comment: "updated",
      commentsDeleted: 1,
      duplicateCommentsDeleted: 1,
    });
    expect(gateway.updateIssueComment).toHaveBeenCalledWith(
      { ...coordinates, commentId: 10, body: expectedBody },
      signal
    );
    expect(gateway.deleteIssueComment).toHaveBeenCalledWith({ ...coordinates, commentId: 20 }, signal);
  });

  it("本文が最新と一致しているコメントは更新も削除もしない", async () => {
    const expectedBody = buildTitleValidationFailureComment(failedValidation);
    const gateway = createGateway([comment(10, 42, expectedBody)]);

    await expect(reconcileTitleValidationComments(gateway, coordinates, expectedBody, 42, signal)).resolves.toEqual({
      comment: "none",
      commentsDeleted: 0,
      duplicateCommentsDeleted: 0,
    });
    expect(gateway.updateIssueComment).not.toHaveBeenCalled();
    expect(gateway.deleteIssueComment).not.toHaveBeenCalled();
  });

  it("marker のない同一 App の別用途コメントは管理対象にしない", async () => {
    const unrelated = comment(1, 42, "unrelated app comment");
    const gateway = createGateway([unrelated]);
    const expectedBody = buildTitleValidationFailureComment(failedValidation);

    await reconcileTitleValidationComments(gateway, coordinates, expectedBody, 42, signal);

    const createInput = vi.mocked(gateway.createIssueComment).mock.calls[0]?.[0];
    expect(createInput?.body).toContain(PR_TITLE_COMMENT_MARKER);
    expect(gateway.updateIssueComment).not.toHaveBeenCalled();
    expect(gateway.deleteIssueComment).not.toHaveBeenCalled();
  });

  it("失敗コメントが不要になったら自身のコメントをすべて削除する", async () => {
    const gateway = createGateway([comment(9, 42), comment(2, 42), comment(3, 99)]);

    await expect(reconcileTitleValidationComments(gateway, coordinates, null, 42, signal)).resolves.toEqual({
      comment: "none",
      commentsDeleted: 2,
      duplicateCommentsDeleted: 1,
    });
    expect(vi.mocked(gateway.deleteIssueComment).mock.calls.map(([input]) => input.commentId)).toEqual([2, 9]);
    expect(gateway.createIssueComment).not.toHaveBeenCalled();
  });

  it("並行 create 後に再取得し、安定 marker の primary 一件へ収束する", async () => {
    const expectedBody = buildTitleValidationFailureComment(failedValidation);
    const comments: IssueComment[] = [];
    let nextId = 1;
    let initialLists = 0;
    let releaseInitialLists: (() => void) | undefined;
    const initialListBarrier = new Promise<void>((resolve) => {
      releaseInitialLists = resolve;
    });
    const gateway: TitleValidationCommentGateway = {
      listIssueComments: vi.fn(async () => {
        if (initialLists < 2) {
          initialLists += 1;
          if (initialLists === 2) releaseInitialLists?.();
          await initialListBarrier;
          return [];
        }
        return comments.map((candidate) => ({ ...candidate, user: candidate.user ? { ...candidate.user } : null }));
      }),
      createIssueComment: vi.fn<TitleValidationCommentGateway["createIssueComment"]>((input) => {
        comments.push(comment(nextId, 42, input.body));
        nextId += 1;
        return Promise.resolve();
      }),
      updateIssueComment: vi.fn<TitleValidationCommentGateway["updateIssueComment"]>((input) => {
        const existing = comments.find((candidate) => candidate.id === input.commentId);
        if (existing) existing.body = input.body;
        return Promise.resolve();
      }),
      deleteIssueComment: vi.fn<TitleValidationCommentGateway["deleteIssueComment"]>((input) => {
        const index = comments.findIndex((candidate) => candidate.id === input.commentId);
        if (index >= 0) comments.splice(index, 1);
        return Promise.resolve();
      }),
    };

    await Promise.all([
      reconcileTitleValidationComments(gateway, coordinates, expectedBody, 42, signal),
      reconcileTitleValidationComments(gateway, coordinates, expectedBody, 42, signal),
    ]);

    expect(gateway.createIssueComment).toHaveBeenCalledTimes(2);
    expect(comments).toEqual([comment(1, 42, expectedBody)]);
  });
});
