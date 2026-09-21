import { TitleValidationExecutionError } from "./errors.js";
import { PR_TITLE_COMMENT_MARKER } from "../../domain/title-comment.js";

import type { IssueComment, TitleValidationGateway } from "./dependencies.js";

interface PullRequestCoordinates {
  owner: string;
  repo: string;
  pullRequestNumber: number;
}

export type TitleValidationCommentGateway = Pick<
  TitleValidationGateway,
  "createIssueComment" | "deleteIssueComment" | "listIssueComments" | "updateIssueComment"
>;

interface TitleValidationCommentOutcome {
  comment: "created" | "none" | "updated";
  commentsDeleted: number;
  duplicateCommentsDeleted: number;
}

export const isCommentCreatedByThisApp = (comment: IssueComment, appBotUserId: number): boolean =>
  comment.user?.id === appBotUserId;

const LEGACY_COMMENT_HEADING = "### Pull Request のタイトルを修正してください";
const MAX_COMMENT_RECONCILIATION_ATTEMPTS = 3;

const isManagedComment = (comment: IssueComment, appBotUserId: number): boolean =>
  isCommentCreatedByThisApp(comment, appBotUserId) &&
  (comment.body?.includes(PR_TITLE_COMMENT_MARKER) === true ||
    comment.body?.startsWith(LEGACY_COMMENT_HEADING) === true);

/** `expectedBody` が null のときは、この App が投稿したコメントをすべて削除する */
export const reconcileTitleValidationComments = async (
  gateway: TitleValidationCommentGateway,
  coordinates: PullRequestCoordinates,
  expectedBody: string | null,
  configuredAppBotUserId: number,
  signal: AbortSignal
): Promise<TitleValidationCommentOutcome> => {
  try {
    const commentRequired = expectedBody !== null;
    let comment: TitleValidationCommentOutcome["comment"] = "none";
    let createAttempted = false;
    const deletedIds = new Set<number>();

    for (let attempt = 0; attempt < MAX_COMMENT_RECONCILIATION_ATTEMPTS; attempt += 1) {
      const managedComments = (await gateway.listIssueComments(coordinates, signal))
        .filter((candidate) => isManagedComment(candidate, configuredAppBotUserId))
        .sort((left, right) => left.id - right.id);

      if (!commentRequired) {
        if (managedComments.length === 0) {
          return {
            comment: "none",
            commentsDeleted: deletedIds.size,
            duplicateCommentsDeleted: Math.max(0, deletedIds.size - 1),
          };
        }
        for (const candidate of managedComments) {
          await gateway.deleteIssueComment({ ...coordinates, commentId: candidate.id }, signal);
          deletedIds.add(candidate.id);
        }
        continue;
      }

      const [primaryComment, ...duplicateComments] = managedComments;
      if (!primaryComment) {
        if (createAttempted) continue;
        await gateway.createIssueComment({ ...coordinates, body: expectedBody }, signal);
        createAttempted = true;
        if (comment === "none") comment = "created";
        continue;
      }

      let mutated = false;
      if (primaryComment.body !== expectedBody) {
        await gateway.updateIssueComment({ ...coordinates, commentId: primaryComment.id, body: expectedBody }, signal);
        if (comment === "none") comment = "updated";
        mutated = true;
      }

      for (const duplicateComment of duplicateComments) {
        await gateway.deleteIssueComment({ ...coordinates, commentId: duplicateComment.id }, signal);
        deletedIds.add(duplicateComment.id);
        mutated = true;
      }
      if (!mutated) {
        return {
          comment,
          commentsDeleted: deletedIds.size,
          duplicateCommentsDeleted: deletedIds.size,
        };
      }
    }

    throw new Error("Title validation comment reconciliation did not converge");
  } catch (error) {
    throw new TitleValidationExecutionError("comment_sync_failed", error);
  }
};
