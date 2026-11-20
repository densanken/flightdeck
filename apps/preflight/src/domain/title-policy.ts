import { hasDraftTitleMarker, validatePullRequestTitle } from "@flightdeck/pr-title";

import {
  buildDraftMarkerTitleComment,
  buildDraftTitleComment,
  buildTitleValidationFailureComment,
} from "./title-comment.js";
import { buildTitleFailureStatusMessage, TITLE_STATUS_MESSAGES } from "./title-status-message.js";

import type { TitleStatusMessage, TitleStatusState } from "./title-status-message.js";
import type { TitleTypePolicy } from "./title-types.js";
import type { TitleValidationResult } from "@flightdeck/pr-title";

interface PullRequestTitle {
  title: string;
  typePolicy?: TitleTypePolicy;
}

interface AssociatedTitle extends PullRequestTitle {
  number: number;
  draft: boolean;
}

export const validateTitle = ({ title, typePolicy }: PullRequestTitle): TitleValidationResult<string> =>
  typePolicy === undefined ? validatePullRequestTitle(title) : validatePullRequestTitle(title, typePolicy.types);

/**
 * gate の判定に加える PR
 * draft PR は GitHub 自身が merge を拒むので外せるが、作業中の接頭辞が付いた PR はそのまま merge できてしまう
 * 接頭辞付きの PR を外すと、同じ commit を head に持つ別の PR が green にした瞬間に接頭辞付きのまま merge できるため、
 * 接頭辞付きの PR は gate に残したまま pending で止める
 */
const isGatingPullRequest = (pullRequest: { draft: boolean }): boolean => !pullRequest.draft;

const gatingPullRequests = (pullRequests: AssociatedTitle[]): AssociatedTitle[] =>
  pullRequests.filter(isGatingPullRequest);

// 処理対象の draft PR はコメントのために type 方針が必要
export const needsTitleTypePolicy = (
  pullRequest: { number: number; draft: boolean },
  currentNumber?: number
): boolean => isGatingPullRequest(pullRequest) || pullRequest.number === currentNumber;

export const allTitlesValid = (pullRequests: AssociatedTitle[]): boolean => {
  const gating = gatingPullRequests(pullRequests);
  return gating.length > 0 && gating.every((pullRequest) => validateTitle(pullRequest).valid);
};

/**
 * commit status に出す state と文言を決める
 * 修正が要る失敗を最優先で出し、次に作業中を示す保留、最後に成功という順で見る
 * 接頭辞付きのタイトルは修正待ちではなく作業中なので、failure ではなく pending にする
 */
export const headVerdict = (input: {
  associatedPullRequests: AssociatedTitle[];
}): { state: TitleStatusState; message: TitleStatusMessage } => {
  if (input.associatedPullRequests.length === 0) return { state: "success", message: TITLE_STATUS_MESSAGES.emptyHead };

  const gating = gatingPullRequests(input.associatedPullRequests);
  // この commit を head に持つ open PR がすべて draft なら、まだ判定しない
  if (gating.length === 0) return { state: "pending", message: TITLE_STATUS_MESSAGES.draft };

  // 接頭辞付きのタイトルは常に validatePullRequestTitle でも無効になるため、無効判定から明示的に除いて保留側へ振り分ける
  const invalid = gating
    .filter((pr) => !hasDraftTitleMarker(pr.title))
    .map((pr) => ({ pr, validation: validateTitle(pr) }))
    .filter(({ validation }) => !validation.valid);
  const [firstInvalid, ...remainingInvalid] = invalid;
  if (firstInvalid) {
    const { pr, validation } = firstInvalid;
    return {
      state: "failure",
      message: buildTitleFailureStatusMessage(
        [pr.number, ...remainingInvalid.map(({ pr: pullRequest }) => pullRequest.number)],
        !validation.valid && validation.reason === "unsupported_type" && pr.typePolicy?.restricted
          ? pr.typePolicy
          : undefined
      ),
    };
  }

  if (gating.some((pullRequest) => hasDraftTitleMarker(pullRequest.title))) {
    return { state: "pending", message: TITLE_STATUS_MESSAGES.wipTitle };
  }

  return { state: "success", message: TITLE_STATUS_MESSAGES.success };
};

/**
 * 処理対象 PR に出すコメント本文
 * 不要なら null
 */
export const commentBody = (state: {
  current: PullRequestTitle & { state: "open" | "closed"; draft: boolean };
  currentValidation: TitleValidationResult<string>;
}): string | null => {
  if (state.current.state !== "open") return null;

  if (state.current.draft && !state.currentValidation.valid) {
    return buildDraftTitleComment(state.currentValidation, state.current.typePolicy);
  }

  if (hasDraftTitleMarker(state.current.title)) {
    return buildDraftMarkerTitleComment(state.current.title, state.current.typePolicy);
  }

  if (!state.currentValidation.valid) {
    return buildTitleValidationFailureComment(state.currentValidation, state.current.typePolicy);
  }

  return null;
};
