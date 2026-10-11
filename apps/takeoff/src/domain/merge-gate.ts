import { validatePullRequestTitle } from "@flightdeck/pr-title";

import { AppError, errors } from "./errors.js";
import { isMarkedDraft } from "./pull-request-draft.js";

import type { TitleValidationFailureReason } from "@flightdeck/pr-title";

export interface MergeGatePullRequest {
  state: string;
  draft: boolean;
  title: string;
  updated_at: string;
  mergeable: boolean | null;
  head: { sha: string };
}

export interface MergeGateCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  app: { id: number; slug?: string } | null;
}

export interface MergeGateRequiredStatusCheck {
  context: string;
  integrationId: number | null;
}

export interface MergeGateCombinedStatus {
  state: string;
  statuses: {
    context: string;
    state: string;
    target_url: string | null;
  }[];
}

export interface FailedCheck {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
}

export interface FailedStatus {
  context: string;
  state: string;
  targetUrl: string | null;
}

export type MergeGateResult = { canMerge: true; headSha: string } | { canMerge: false; error: AppError };

export type PullRequestGateResult = { ok: true } | { ok: false; error: AppError };

const PR_UPDATE_WAIT_MS = 60_000;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/;

const parseIsoUtcTimestamp = (value: string): number | null => {
  if (!ISO_UTC_TIMESTAMP.test(value)) return null;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  const date = value.slice(0, 10);
  if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) return null;

  return timestamp;
};

const titleValidationFailureMessage = (reason: TitleValidationFailureReason): string => {
  switch (reason) {
    case "empty":
      return "PR title must not be empty";
    case "surrounding_whitespace":
      return "PR title must not start or end with whitespace";
    case "invalid_format":
      return "PR title does not match the pattern: type(scope)!: description";
    case "fullwidth_symbol":
      return "PR title must not contain full-width symbols";
    case "unsupported_type":
      return "PR title uses an unsupported type";
    case "invalid_scope":
      return "PR title scope is invalid";
    case "invalid_description":
      return "PR title description is invalid";
  }
};

export const evaluateCheckRuns = (checkRuns: MergeGateCheckRun[]): FailedCheck[] => {
  if (checkRuns.length === 0) return [];

  return checkRuns
    .filter((cr) => {
      if (cr.status === "completed" && (cr.conclusion === "success" || cr.conclusion === "skipped")) {
        return false;
      }
      return true;
    })
    .map((cr) => ({
      name: cr.name,
      status: cr.status,
      conclusion: cr.conclusion,
      htmlUrl: cr.html_url,
    }));
};

export const evaluateCombinedStatus = (combinedStatus: MergeGateCombinedStatus): { passed: boolean; state: string } => {
  if (combinedStatus.statuses.length === 0) {
    return { passed: true, state: "none" };
  }
  return { passed: combinedStatus.state === "success", state: combinedStatus.state };
};

export const getFailedStatuses = (combinedStatus: MergeGateCombinedStatus): FailedStatus[] =>
  combinedStatus.statuses
    .filter((status) => status.state !== "success")
    .map((status) => ({
      context: status.context,
      state: status.state,
      targetUrl: status.target_url,
    }));

// PR 単体で完結する検査（state, draft, draft marker, Conventional PR Title, 更新後の待機）
// merge 直前の再検証でも同じ判定を使い回すため、check runs や mergeable の検査とは切り離す
export const evaluatePullRequestGate = (pr: MergeGatePullRequest, now: string): PullRequestGateResult => {
  // 1. PR state
  if (pr.state !== "open") {
    return { ok: false, error: errors.prNotOpen() };
  }

  // 2. Draft
  if (pr.draft) {
    return { ok: false, error: errors.prIsDraft() };
  }

  // 3. Draft marker in title
  if (isMarkedDraft(pr.title)) {
    return { ok: false, error: errors.prTitleMarkedDraft() };
  }

  // 4. Conventional PR Title
  const titleResult = validatePullRequestTitle(pr.title);
  if (!titleResult.valid) {
    return { ok: false, error: errors.invalidPrTitle(titleValidationFailureMessage(titleResult.reason)) };
  }

  const nowMs = parseIsoUtcTimestamp(now);
  const updatedAtMs = parseIsoUtcTimestamp(pr.updated_at);
  if (nowMs === null || updatedAtMs === null || nowMs - updatedAtMs < PR_UPDATE_WAIT_MS) {
    return { ok: false, error: errors.prRecentlyUpdated() };
  }

  return { ok: true };
};

// Check Runs と Combined Status の検査（merge gate の 6〜7）
// merge 直前の再検証でも head と test merge commit の両方から取り直すため、PR 単体の検査と切り離す
export const evaluateChecksAndStatusGate = (
  checkRuns: MergeGateCheckRun[],
  combinedStatus: MergeGateCombinedStatus,
  requiredStatusChecks: MergeGateRequiredStatusCheck[] | null
): PullRequestGateResult => {
  // 6. Check Runs
  const failedChecks = evaluateCheckRuns(checkRuns);
  if (failedChecks.length > 0) {
    const hasPending = failedChecks.some((c) => c.status !== "completed");
    if (hasPending) {
      return { ok: false, error: errors.checksPending({ failedChecks }) };
    }
    return { ok: false, error: errors.checksFailed({ failedChecks }) };
  }

  // 7. Combined Status
  const statusResult = evaluateCombinedStatus(combinedStatus);
  if (!statusResult.passed) {
    const failedStatuses = getFailedStatuses(combinedStatus);
    if (statusResult.state === "pending") {
      return {
        ok: false,
        error: errors.statusesPending({ state: statusResult.state, failedStatuses }),
      };
    }
    return {
      ok: false,
      error: errors.statusesFailed({ state: statusResult.state, failedStatuses }),
    };
  }

  if (requiredStatusChecks?.length === 0) {
    return { ok: false, error: errors.requiredChecksPolicyMissing() };
  }

  // Rules API を GitHub plan の制限で利用できない場合は、取得できた check/status の評価後に許可する
  // 権限不足や一時障害はここへ到達せず fail-closed のまま
  if (requiredStatusChecks === null) {
    return checkRuns.some((checkRun) => checkRun.app?.slug === "github-actions")
      ? { ok: true }
      : { ok: false, error: errors.checksNotRegistered() };
  }

  const missingRequiredChecks = requiredStatusChecks.flatMap((requiredCheck) => {
    const matchingCheckRuns = checkRuns.filter((checkRun) => checkRun.name === requiredCheck.context);
    const matchingStatuses = combinedStatus.statuses.filter((status) => status.context === requiredCheck.context);
    const satisfied =
      requiredCheck.integrationId === null
        ? matchingCheckRuns.some(
            (checkRun) =>
              checkRun.status === "completed" &&
              (checkRun.conclusion === "success" || checkRun.conclusion === "skipped")
          ) || matchingStatuses.some((status) => status.state === "success")
        : matchingCheckRuns.some(
            (checkRun) =>
              checkRun.app?.id === requiredCheck.integrationId &&
              checkRun.status === "completed" &&
              (checkRun.conclusion === "success" || checkRun.conclusion === "skipped")
          );
    if (satisfied) return [];

    const hasMatchingContext = matchingCheckRuns.length > 0 || matchingStatuses.length > 0;
    return [
      {
        context: requiredCheck.context,
        integrationId: requiredCheck.integrationId,
        reason: hasMatchingContext ? "source_mismatch" : "missing",
      },
    ];
  });
  if (missingRequiredChecks.length > 0) {
    return { ok: false, error: errors.requiredChecksMissing({ requiredChecks: missingRequiredChecks }) };
  }

  if (!checkRuns.some((checkRun) => checkRun.app?.slug === "github-actions")) {
    return { ok: false, error: errors.checksNotRegistered() };
  }

  return { ok: true };
};

export const evaluateMergeGate = (
  pr: MergeGatePullRequest,
  checkRuns: MergeGateCheckRun[],
  combinedStatus: MergeGateCombinedStatus,
  requiredStatusChecks: MergeGateRequiredStatusCheck[] | null,
  now: string
): MergeGateResult => {
  // 1〜4. PR 単体の検査
  const prGateResult = evaluatePullRequestGate(pr, now);
  if (!prGateResult.ok) {
    return { canMerge: false, error: prGateResult.error };
  }

  // 5. Mergeable
  if (pr.mergeable === null) {
    return { canMerge: false, error: errors.mergeabilityChecking() };
  }
  if (!pr.mergeable) {
    return { canMerge: false, error: errors.mergeConflict() };
  }

  // 6〜7. Check Runs と Combined Status
  const checksResult = evaluateChecksAndStatusGate(checkRuns, combinedStatus, requiredStatusChecks);
  if (!checksResult.ok) {
    return { canMerge: false, error: checksResult.error };
  }

  return { canMerge: true, headSha: pr.head.sha };
};
