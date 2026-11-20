import type { AssociatedPullRequestTitle, PullRequestTitleState } from "./dependencies.js";
import type { TitleTypePolicy } from "../../domain/title-types.js";
import type { TitleValidationResult } from "@flightdeck/pr-title";

export interface PullRequestPolicyState {
  current: PullRequestTitleState;
  associatedPullRequests: AssociatedPullRequestTitle[];
  currentValidation: TitleValidationResult<string>;
  allTitlesValid: boolean;
}

export interface DetachedHeadPolicyState {
  headSha: string;
  associatedPullRequests: AssociatedPullRequestTitle[];
  current?: PullRequestTitleState;
}

type ComparableTitleState = Pick<
  PullRequestTitleState,
  "title" | "headSha" | "draft" | "baseSha" | "changedFiles" | "typePolicy"
>;

// draft は verdict を決める入力なので、比較から外すと draft の切り替えを「変化なし」と見て古い verdict のまま止まる
const sameTitleState = (left: ComparableTitleState, right: ComparableTitleState): boolean =>
  left.title === right.title &&
  left.headSha === right.headSha &&
  left.baseSha === right.baseSha &&
  left.changedFiles === right.changedFiles &&
  left.draft === right.draft &&
  sameTypePolicy(left.typePolicy, right.typePolicy);

const samePullRequestState = (left: PullRequestTitleState, right: PullRequestTitleState): boolean =>
  left.state === right.state && sameTitleState(left, right);

const sameTypePolicy = (left: TitleTypePolicy | undefined, right: TitleTypePolicy | undefined): boolean =>
  left === undefined
    ? right === undefined
    : left.restricted === right?.restricted &&
      left.types.length === right.types.length &&
      left.types.every((type, index) => type === right.types[index]);

export const sameAssociatedPullRequests = (
  left: AssociatedPullRequestTitle[],
  right: AssociatedPullRequestTitle[]
): boolean =>
  left.length === right.length &&
  left.every((pullRequest, index) => {
    const candidate = right.at(index);

    return pullRequest.number === candidate?.number && sameTitleState(pullRequest, candidate);
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
        baseSha: current.state.baseSha,
        changedFiles: current.state.changedFiles,
      });
    } else {
      byNumber.delete(current.number);
    }
  }

  return [...byNumber.values()].sort((left, right) => left.number - right.number);
};
