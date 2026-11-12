import {
  automergeDisabled,
  chooseConfig,
  classify,
  CONFIG_PATHS,
  ConfigError,
  evaluateCi,
  humanActivity,
  parseAutopilotConfig,
  sourceOf,
  verifyGitlink,
  verifySourceHistory,
} from "@flightdeck/rules";

import { errorDetails } from "./error-details.js";
import { reviewAction } from "../../domain/review.js";
import { ApiError } from "../../errors.js";

import type { ApprovalGateway, PolicySettings, PullRequest } from "./dependencies.js";
import type { Decision, Review } from "../../domain/review.js";
import type { Logger } from "@flightdeck/logger";
import type { PolicyKind } from "@flightdeck/rules";

const result = (kind: "skip" | "violated" | "undeterminable", reasonCode: string): Decision => ({ kind, reasonCode });

const readConfig = async (github: ApprovalGateway, baseOid: string) => {
  try {
    return parseAutopilotConfig(chooseConfig(await github.configs(baseOid))?.text ?? "");
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
};

export const decide = async (
  github: ApprovalGateway,
  repositoryId: number,
  pr: PullRequest,
  settings: PolicySettings,
  now: number
): Promise<Decision> => {
  const policy = classify(pr.author?.id ?? null, settings.dispatchId, settings.renovateIds);

  if (pr.state !== "OPEN") return result("skip", "not_open");

  if (!policy) return result("skip", "unknown_author");

  const config = await readConfig(github, pr.baseOid);
  if (config instanceof ConfigError) return result("undeterminable", config.code);

  if (pr.draft) return result("violated", "draft");
  if (pr.labels.some((label) => label.toLowerCase() === "autopilot:skip")) return result("violated", "opted_out");
  if (pr.files.some((file) => Object.values(CONFIG_PATHS).includes(file.path))) {
    return result("violated", "config_changed");
  }
  if (pr.headRepositoryId !== repositoryId) return result("violated", "fork");
  if (pr.opinionatedReviews.some((review) => review.state === "CHANGES_REQUESTED" && review.author?.type === "User")) {
    return result("violated", "human_changes_requested");
  }

  if (policy === "dispatch") {
    const source = sourceOf(pr.branch);
    const file = pr.files[0];

    if (!source || pr.files.length !== 1 || file?.changeType !== "MODIFIED") return result("violated", "invalid_diff");
    if (!pr.submodulesComplete) return result("undeterminable", "submodules_truncated");

    const matches = pr.submodules.filter((item) => item.path === file.path);
    if (matches.length > 1) return result("undeterminable", "ambiguous_submodule");

    const trees = await github.trees(pr.baseOid, pr.headSha, file.path);
    const gitlink = { source, submoduleUrl: matches[0]?.gitUrl ?? null, ...trees };
    if (!verifyGitlink(gitlink)) return result("violated", "invalid_gitlink");

    const comparisons = await github.compare(source, gitlink.head.oid, gitlink.base.oid);
    const verified = verifySourceHistory(comparisons.source, comparisons.ancestry);
    if (verified !== "allowed") return result(verified, "invalid_source_history");
  } else {
    if (!config.renovateStale) return result("violated", "renovate_disabled");
    if (!automergeDisabled(pr.body)) return result("violated", "automerge_enabled");

    const activity = humanActivity({
      createdAt: pr.createdAt,
      editor: pr.editor,
      lastEditedAt: pr.lastEditedAt,
      timeline: pr.timeline,
      pageCount: pr.timelinePageCount,
      hasPreviousPage: pr.timelineHasPreviousPage,
      recentCount: pr.recentCount,
      renovateIds: settings.renovateIds,
      now,
    });
    if (activity !== "allowed") return result(activity, "human_activity");

    const initial = evaluateCi(pr.checks, pr.statuses, []);
    if (initial === "blocked") return result("violated", "ci_failed");
    if (initial === "pending") return result("undeterminable", "ci_pending");

    const rules = await github.rules(pr.baseBranch);
    const status = evaluateCi(pr.checks, pr.statuses, rules);
    if (status === "pending") return result("undeterminable", "ci_pending");
    if (status === "blocked") return result("violated", "ci_failed");
  }

  // GraphQL では改名元の path が分からず、設定ファイルの改名を否定できない
  if (
    policy === "renovate-stale" &&
    pr.files.some((file) => file.changeType === "RENAMED" || file.changeType === "COPIED")
  ) {
    return result("undeterminable", "config_rename_unknown");
  }

  return { kind: "allowed", policy, headSha: pr.headSha };
};

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
  decision: Decision;
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
    apiStatus: error instanceof ApiError ? error.status : undefined,
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
  latest: Review | undefined,
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
      if (error instanceof ApiError && error.status === 422 && (await dismissed(github, number, outcome.reviewId))) {
        return { ...outcome, action: "already_dismissed", apiStatus: error.status };
      }

      return failed(error, { ...outcome, action: "dismiss_failed" });
    }
  }

  return outcome;
};

const evaluateFetched = async (
  github: ApprovalGateway,
  number: number,
  settings: PolicySettings,
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
  settings: PolicySettings,
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
  settings: PolicySettings,
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
