import { hasDraftTitleMarker, validatePullRequestTitle } from "@flightdeck/pr-title";

import {
  buildDraftMarkerTitleComment,
  buildDraftTitleComment,
  buildTitleValidationFailureComment,
} from "../../domain/title-comment.js";
import { buildTitleFailureStatusMessage, TITLE_STATUS_MESSAGES } from "../../domain/title-status-message.js";

import type { AssociatedPullRequestTitle, PullRequestTitleState, TitleStatusState } from "./dependencies.js";
import type { TitleStatusMessage } from "../../domain/title-status-message.js";
import type { TitleValidationResult } from "@flightdeck/pr-title";

const {
  success: SUCCESS_MESSAGE,
  draft: DRAFT_MESSAGE,
  wipTitle: WIP_TITLE_MESSAGE,
  emptyHead: EMPTY_HEAD_MESSAGE,
} = TITLE_STATUS_MESSAGES;

export interface PullRequestPolicyState {
  current: PullRequestTitleState;
  associatedPullRequests: AssociatedPullRequestTitle[];
  currentValidation: TitleValidationResult;
  allTitlesValid: boolean;
}

export interface DetachedHeadPolicyState {
  headSha: string;
  associatedPullRequests: AssociatedPullRequestTitle[];
  current?: PullRequestTitleState;
}

// draft は verdict を決める入力なので、比較から外すと draft の切り替えを「変化なし」と見て古い verdict のまま止まる
const samePullRequestState = (left: PullRequestTitleState, right: PullRequestTitleState): boolean =>
  left.title === right.title &&
  left.headSha === right.headSha &&
  left.state === right.state &&
  left.draft === right.draft;

export const sameAssociatedPullRequests = (
  left: AssociatedPullRequestTitle[],
  right: AssociatedPullRequestTitle[]
): boolean =>
  left.length === right.length &&
  left.every((pullRequest, index) => {
    const candidate = right.at(index);
    return (
      pullRequest.number === candidate?.number &&
      pullRequest.title === candidate.title &&
      pullRequest.headSha === candidate.headSha &&
      pullRequest.draft === candidate.draft
    );
  });

export const samePolicyState = (left: PullRequestPolicyState, right: PullRequestPolicyState): boolean =>
  samePullRequestState(left.current, right.current) &&
  sameAssociatedPullRequests(left.associatedPullRequests, right.associatedPullRequests);

export const sameDetachedHeadState = (left: DetachedHeadPolicyState, right: DetachedHeadPolicyState): boolean =>
  left.headSha === right.headSha &&
  sameAssociatedPullRequests(left.associatedPullRequests, right.associatedPullRequests) &&
  (left.current === undefined
    ? right.current === undefined
    : right.current !== undefined && samePullRequestState(left.current, right.current));

export const normalizeAssociatedPullRequests = (
  associatedPullRequests: AssociatedPullRequestTitle[],
  headSha: string,
  current?: { number: number; state: PullRequestTitleState }
): AssociatedPullRequestTitle[] => {
  const byNumber = new Map<number, AssociatedPullRequestTitle>();
  for (const pullRequest of associatedPullRequests) {
    if (pullRequest.headSha !== headSha || byNumber.has(pullRequest.number)) {
      throw new Error("Invalid associated pull request state");
    }
    byNumber.set(pullRequest.number, pullRequest);
  }

  if (current) {
    if (current.state.state === "open" && current.state.headSha === headSha) {
      byNumber.set(current.number, {
        number: current.number,
        title: current.state.title,
        headSha,
        draft: current.state.draft,
      });
    } else {
      byNumber.delete(current.number);
    }
  }

  return [...byNumber.values()].sort((left, right) => left.number - right.number);
};

/**
 * gate の判定に加える PR
 * draft PR は GitHub 自身が merge を拒むので外せるが、作業中の接頭辞が付いた PR はそのまま merge できてしまう
 * 接頭辞付きの PR を外すと、同じ commit を head に持つ別の PR が green にした瞬間に接頭辞付きのまま merge できるため、
 * 接頭辞付きの PR は gate に残したまま pending で止める
 */
const gatingPullRequests = (pullRequests: AssociatedPullRequestTitle[]): AssociatedPullRequestTitle[] =>
  pullRequests.filter((pullRequest) => !pullRequest.draft);

export const allTitlesValid = (pullRequests: AssociatedPullRequestTitle[]): boolean => {
  const gating = gatingPullRequests(pullRequests);
  return gating.length > 0 && gating.every((pullRequest) => validatePullRequestTitle(pullRequest.title).valid);
};

// 接頭辞付きのタイトルは常に validatePullRequestTitle でも無効になるため、無効判定から明示的に除いて保留側へ振り分ける
const isInvalidGatingTitle = (title: string): boolean =>
  !hasDraftTitleMarker(title) && !validatePullRequestTitle(title).valid;

/**
 * commit status に出す state と文言を決める
 * 修正が要る失敗を最優先で出し、次に作業中を示す保留、最後に成功という順で見る
 * 接頭辞付きのタイトルは修正待ちではなく作業中なので、failure ではなく pending にする
 */
export const headVerdict = (input: {
  associatedPullRequests: AssociatedPullRequestTitle[];
}): { state: TitleStatusState; message: TitleStatusMessage } => {
  if (input.associatedPullRequests.length === 0) return { state: "success", message: EMPTY_HEAD_MESSAGE };

  const gating = gatingPullRequests(input.associatedPullRequests);
  // この commit を head に持つ open PR がすべて draft なら、まだ判定しない
  if (gating.length === 0) return { state: "pending", message: DRAFT_MESSAGE };

  const invalid = gating.filter((pullRequest) => isInvalidGatingTitle(pullRequest.title));
  const [firstInvalid, ...remainingInvalid] = invalid;
  if (firstInvalid) {
    return {
      state: "failure",
      message: buildTitleFailureStatusMessage([
        firstInvalid.number,
        ...remainingInvalid.map((pullRequest) => pullRequest.number),
      ]),
    };
  }

  const wip = gating.filter((pullRequest) => hasDraftTitleMarker(pullRequest.title));
  if (wip.length > 0) return { state: "pending", message: WIP_TITLE_MESSAGE };

  return { state: "success", message: SUCCESS_MESSAGE };
};

/**
 * 処理対象 PR に出すコメント本文
 * 不要なら null
 */
export const commentBody = (state: PullRequestPolicyState): string | null => {
  if (state.current.state !== "open") return null;
  if (state.current.draft && !state.currentValidation.valid) return buildDraftTitleComment(state.currentValidation);
  if (hasDraftTitleMarker(state.current.title)) return buildDraftMarkerTitleComment(state.current.title);
  if (!state.currentValidation.valid) return buildTitleValidationFailureComment(state.currentValidation);

  return null;
};

export const currentHeadVerdict = (
  state: PullRequestPolicyState
): { state: TitleStatusState; message: TitleStatusMessage } =>
  headVerdict({ associatedPullRequests: state.associatedPullRequests });
