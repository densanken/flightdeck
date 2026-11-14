import { decide, errorDetails } from "@flightdeck/github-policy";
import { classify } from "@flightdeck/rules";

import { reviewAction } from "../../domain/review.js";

import type { ApprovalGateway, ApprovalSettings } from "./dependencies.js";
import type { Logger } from "@flightdeck/logger";
import type { PolicyDecision, PolicyKind, PolicyReview } from "@flightdeck/rules";

const result = (kind: "skip" | "violated" | "undeterminable", reasonCode: string): PolicyDecision => ({
  kind,
  reasonCode,
});

interface EvaluateOptions {
  fields: Record<string, unknown>;
  expectedRepositoryId: number;
  // CI の結果を契機とする評価では、その commit の SHA
  commitSha?: string;
  // true なら Approve せず、条件違反の Dismiss だけを行う
  dismissOnly?: boolean;
  clock: () => number;
}

interface EvaluationOutcome {
  decision: PolicyDecision;
  action: string;
  reviewId: number | null;
  apiStatus: number | undefined;
  failure: ReturnType<typeof errorDetails> | undefined;
  headSha: string | undefined;
  queryCost: number | undefined;
  policy: PolicyKind | null;
}

const initialOutcome = (): EvaluationOutcome => ({
  decision: result("undeterminable", "api_error"),
  action: "none",
  reviewId: null,
  apiStatus: undefined,
  failure: undefined,
  headSha: undefined,
  queryCost: undefined,
  policy: null,
});

const failed = (error: unknown, outcome: EvaluationOutcome): EvaluationOutcome => {
  const failure = errorDetails(error);

  return {
    ...outcome,
    decision:
      failure.reasonCode === "subrequest_limit" || outcome.action === "none"
        ? result("undeterminable", failure.reasonCode)
        : outcome.decision,
    apiStatus: failure.apiStatus,
    failure,
  };
};

const dismissed = async (github: ApprovalGateway, number: number, reviewId: number) => {
  try {
    return (await github.reviewState(number, reviewId)) === "DISMISSED";
  } catch {
    return false;
  }
};

const applyReview = async (
  github: ApprovalGateway,
  number: number,
  latest: PolicyReview | undefined,
  outcome: EvaluationOutcome
): Promise<EvaluationOutcome> => {
  const next = reviewAction(outcome.decision, latest);

  if (next === "already_approved") return { ...outcome, action: next };
  if (next === "missing_id") return { ...outcome, decision: result("undeterminable", "review_id_missing") };

  if (next === "approve" && outcome.decision.kind === "allowed") {
    try {
      const response = await github.approve(number, outcome.decision.headSha);

      return { ...outcome, action: "approved", reviewId: response.reviewId, apiStatus: response.status };
    } catch (error) {
      return failed(error, { ...outcome, action: "approve_failed", reviewId: null });
    }
  }

  if (next === "dismiss" && outcome.decision.kind === "violated" && outcome.reviewId !== null) {
    try {
      const response = await github.dismiss(number, outcome.reviewId, outcome.decision.reasonCode);

      return { ...outcome, action: "dismissed", apiStatus: response.status };
    } catch (error) {
      // 同時に届いた別の評価が先に Dismiss すると 422 になる
      // 権限による拒否も 422 になりうるため、レビューの状態を確かめる
      const status = errorDetails(error).apiStatus;
      if (status === 422 && (await dismissed(github, number, outcome.reviewId))) {
        return { ...outcome, action: "already_dismissed", apiStatus: status };
      }

      return failed(error, { ...outcome, action: "dismiss_failed" });
    }
  }

  return outcome;
};

const evaluateFetched = async (
  github: ApprovalGateway,
  number: number,
  settings: ApprovalSettings,
  now: number,
  options: EvaluateOptions,
  data: Awaited<ReturnType<ApprovalGateway["pullRequest"]>>
): Promise<EvaluationOutcome> => {
  const { repositoryId, pr, queryCost } = data;
  const outcome: EvaluationOutcome = {
    ...initialOutcome(),
    headSha: pr.headSha,
    queryCost,
    policy: classify(pr.author?.id ?? null, settings.dispatchId, settings.renovateIds),
  };

  try {
    if (repositoryId !== options.expectedRepositoryId) {
      return { ...outcome, decision: result("skip", "repository_mismatch") };
    }
    if (options.commitSha !== undefined && pr.headSha !== options.commitSha && pr.mergeSha !== options.commitSha) {
      return { ...outcome, decision: result("skip", "sha_mismatch") };
    }

    const decision = await decide(github, repositoryId, pr, settings, now);
    const latest = pr.reviews.find((review) => review.author?.id === settings.botUserId);
    const evaluated = { ...outcome, decision, reviewId: latest?.id ?? null };

    // dispatch PR の判定は CI に依存しないため、CI の結果では Approve しない
    // 同じ push で同時に届く pull_request のイベントと Approve が重複しないようにする
    if (
      decision.kind === "allowed" &&
      (options.dismissOnly === true || (options.commitSha !== undefined && decision.policy === "dispatch"))
    ) {
      return { ...evaluated, action: "approve_skipped" };
    }

    return await applyReview(github, number, latest, evaluated);
  } catch (error) {
    return failed(error, outcome);
  }
};

const evaluatePullRequest = async (
  github: ApprovalGateway,
  number: number,
  settings: ApprovalSettings,
  options: EvaluateOptions
): Promise<EvaluationOutcome> => {
  try {
    const now = options.clock();
    const data = await github.pullRequest(number, now);

    return await evaluateFetched(github, number, settings, now, options, data);
  } catch (error) {
    return failed(error, initialOutcome());
  }
};

export const evaluate = async (
  github: ApprovalGateway,
  number: number,
  settings: ApprovalSettings,
  logger: Logger,
  options: EvaluateOptions
) => {
  const { fields, clock } = options;
  const start = clock();
  const outcome = await evaluatePullRequest(github, number, settings, options);
  const { decision, action, reviewId, apiStatus, failure, headSha, queryCost, policy } = outcome;

  logger.log(action.endsWith("failed") || decision.kind === "undeterminable" ? "warn" : "info", {
    event: "evaluation",
    ...fields,
    pr_number: number,
    decision: decision.kind,
    policy: policy ?? undefined,
    head_sha: headSha,
    reason_code: decision.kind === "allowed" ? undefined : decision.reasonCode,
    action,
    review_id: reviewId,
    api_status: apiStatus,
    error_reason_code: failure?.reasonCode,
    error_name: failure?.errorName,
    error_message: failure?.errorMessage,
    subrequests: github.subrequests(),
    graphql_cost: queryCost,
    duration_ms: clock() - start,
  });
};
