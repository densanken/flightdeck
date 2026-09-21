import { underlyingError } from "./feature-result.js";
import { AppError, ConfigurationError, GitHubError } from "../../errors.js";
import { TitleValidationExecutionError } from "../../usecase/title-validation/errors.js";

import type { RequestLogContext } from "./context.js";
import type { FeatureResult } from "../../usecase/pull-request-policy/interface.js";
import type { Logger, LogRecord } from "../../util/logger.js";

export const policyLog = (
  logger: Logger,
  level: "debug" | "info" | "warn" | "error",
  result: string,
  context: RequestLogContext,
  startedAt: number,
  // 機能単位の log だけに feature を付け、delivery 全体の log では undefined のまま出す
  feature?: FeatureResult["feature"],
  extra: Partial<LogRecord> = {}
): void => {
  logger.log(level, {
    event: "github_webhook_consume",
    result,
    feature,
    ...context,
    durationMs: Date.now() - startedAt,
    ...extra,
  });
};

export const logFeatureFailure = (
  featureResult: Extract<FeatureResult, { outcome: "failed" }>,
  logger: Logger,
  context: RequestLogContext,
  startedAt: number
): void => {
  const error = underlyingError(featureResult.error);
  const appError = error instanceof AppError ? error : undefined;
  const githubError = error instanceof GitHubError ? error : undefined;
  const configurationError = error instanceof ConfigurationError ? error : undefined;
  const result =
    featureResult.error instanceof TitleValidationExecutionError
      ? featureResult.error.stage
      : appError?.code === "GITHUB_AUTH_FAILED"
        ? "github_auth_failed"
        : appError?.code === "GITHUB_API_FAILED"
          ? "github_api_failed"
          : "internal_error";
  policyLog(logger, "error", result, context, startedAt, featureResult.feature, {
    errorCode: appError?.code ?? "INTERNAL_ERROR",
    configKey: configurationError?.configKey,
    configReason: configurationError?.reason,
    githubStatus: githubError?.githubStatus,
    githubRequestId: githubError?.githubRequestId,
    retryAfter: githubError?.retryAfter,
  });
};

export const logFeatureResult = (
  feature: Exclude<FeatureResult, { outcome: "failed" }>,
  logger: Logger,
  context: RequestLogContext,
  startedAt: number
): void => {
  if (feature.outcome === "duplicate") {
    policyLog(logger, "info", "duplicate_delivery", context, startedAt, feature.feature);
    return;
  }
  policyLog(logger, "info", feature.result, context, startedAt, feature.feature);
  // 以降は title-validation だけが持つ field を読むため、auto-assign はここで打ち切る
  if (feature.feature === "auto-assign") return;

  if (feature.comment === "created") {
    policyLog(logger, "info", "comment_created", context, startedAt, feature.feature);
  } else if (feature.comment === "updated") {
    policyLog(logger, "info", "comment_updated", context, startedAt, feature.feature);
  }
  if (feature.commentsDeleted > 0) {
    policyLog(logger, "info", "comment_deleted", context, startedAt, feature.feature, {
      commentCount: feature.commentsDeleted,
    });
  }
  if (feature.duplicateCommentsDeleted > 0) {
    policyLog(logger, "info", "duplicate_comments_deleted", context, startedAt, feature.feature, {
      commentCount: feature.duplicateCommentsDeleted,
    });
  }
  if (feature.supersededStatusesCleared > 0) {
    policyLog(logger, "info", "superseded_statuses_cleared", context, startedAt, feature.feature, {
      commitCount: feature.supersededStatusesCleared,
    });
  }
  // gate は head commit の status で決まるため、掃除の失敗は delivery を落とさない
  // log だけ残す
  if (feature.supersededSweepFailed) {
    policyLog(logger, "warn", "superseded_sweep_failed", context, startedAt, feature.feature);
  }
};
