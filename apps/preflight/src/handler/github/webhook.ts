import { failureErrorCode } from "./feature-result.js";
import { logFeatureFailure, logFeatureResult, policyLog } from "./logging.js";
import { triggersTitleValidation } from "../../domain/webhook-actions.js";
import { AppError, ConfigurationError } from "../../errors.js";

import type { RequestLogContext } from "./context.js";
import type { PullRequestWebhookPayload } from "./payload.js";
import type { ErrorCode } from "../../errors.js";
import type { FeatureResult, PullRequestPolicyUseCase } from "../../usecase/pull-request-policy/interface.js";
import type { Logger } from "../../util/logger.js";

interface PendingTitleStatusInput {
  installationId: number;
  owner: string;
  repo: string;
  sha: string;
}

export interface WebhookDelivery {
  deliveryId: string;
  /**
   * Queue の配信回数
   * 1 が初回で、2 以上は前の attempt が途中まで処理した可能性がある
   */
  attempt: number;
}

export interface GitHubWebhookProcessorDependencies {
  policyUseCase: PullRequestPolicyUseCase;
  logger: Logger;
  hardDeadlineSignal?: AbortSignal;
  createHardDeadlineSignal?: () => AbortSignal;
  createSoftDeadlineSignal?: () => AbortSignal;
  createPendingStatusSignal?: () => AbortSignal;
  setPendingTitleStatus?: (input: PendingTitleStatusInput, signal: AbortSignal) => Promise<void>;
  hasProcessedTitleValidation?: (deliveryId: string, signal: AbortSignal) => Promise<boolean>;
}

export type GitHubWebhookProcessOutcome =
  { status: "processed"; result: string } | { status: "failed"; errorCode: ErrorCode };

// 検証済み payload の処理は Queue consumer で走る
// consumer 1 回の実行は wall time 最大 15 分、CPU time 既定 30 秒で、これなら invocation が platform 側の上限で打ち切られない
// 重複配信と並行配信は wall time とは独立に起こるため、この値は再配信されない保証ではない
// batch の message は逐次処理するので HARD_DEADLINE_MS × max_batch_size を 15 分未満に保つ
export const HARD_DEADLINE_MS = 60_000;
// 失敗後の status 再収束と fail-closed の投稿へ 5 秒を残す
const SOFT_DEADLINE_MS = 55_000;
// 検証本体に使える時間を削らないよう、pending の書き込みは短い deadline で打ち切る
const PENDING_STATUS_DEADLINE_MS = 2_500;

/**
 * 検証を始める前に pending を投稿し、前回の verdict が残ったまま処理が進まないようにする
 *
 * それでも pending が残るのは次の 2 つ
 * どちらもその PR への次の webhook で解消する
 * 1. 同じ delivery が並走し、pending 可否の判定と usecase の duplicate 判定という 2 回の cache read の間に別の実行が markProcessed した場合
 *    後続は pending を書いたあと duplicate と判定して verdict を書かない
 * 2. verdict を書けないまま delivery が終わる場合
 *    auto-assign が soft deadline を使い切って fail-closed の status も hard deadline 内に書けないときと、
 *    5 回の retry を通じて status 投稿が失敗し続けたときが該当する
 */
const postPendingTitleStatus = async (
  dependencies: GitHubWebhookProcessorDependencies,
  payload: PullRequestWebhookPayload,
  delivery: WebhookDelivery,
  context: RequestLogContext,
  startedAt: number,
  signal: AbortSignal
): Promise<void> => {
  const setPendingTitleStatus = dependencies.setPendingTitleStatus;
  if (!setPendingTitleStatus) return;
  if (!triggersTitleValidation(payload.action, payload.changes?.title !== undefined)) return;

  // 機能ごとに処理済みを記録するため、前の attempt が title の verdict だけ書き終えている場合がある
  // delivery cache は colo-local で別 colo の attempt を確認できないので、retry では pending を書かない
  // 確定した status を pending へ戻して gate を開閉させるより、pending を落とすほうが影響は小さい
  if (delivery.attempt > 1) {
    policyLog(dependencies.logger, "info", "pending_status_skipped", context, startedAt, "title-validation", {
      reason: "retry",
      attempt: delivery.attempt,
    });
    return;
  }

  const pendingSignal = AbortSignal.any([
    signal,
    dependencies.createPendingStatusSignal?.() ?? AbortSignal.timeout(PENDING_STATUS_DEADLINE_MS),
  ]);
  try {
    // 処理済み delivery の再配信では usecase が duplicate と判定して何も書かない
    // そこへ pending を書くと確定済みの verdict が pending のまま残るので、この場合は書かない
    // 判定できないときも書かない
    // pending を落とすほうが、gate を pending で固めるより影響は小さい
    if (await dependencies.hasProcessedTitleValidation?.(delivery.deliveryId, pendingSignal)) {
      policyLog(dependencies.logger, "info", "pending_status_skipped", context, startedAt, "title-validation", {
        reason: "processed",
      });
      return;
    }
    await setPendingTitleStatus(
      {
        installationId: payload.installation.id,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        sha: payload.pullRequest.head.sha,
      },
      pendingSignal
    );
  } catch (error) {
    // pending は best-effort
    // 書けなくても検証はこのまま続け、最終的な verdict で上書きする
    // timedOut は 2.5 秒の deadline 超過と GitHub 障害を alert 側で切り分けるために出す
    policyLog(dependencies.logger, "warn", "pending_status_failed", context, startedAt, "title-validation", {
      errorCode: error instanceof Error ? error.name : "unknown_error",
      timedOut: pendingSignal.aborted,
    });
  }
};

/**
 * 署名検証済みの `pull_request` payload を処理する
 * HTTP 境界の header 検証、署名検証、body 読み取りは producer 側の webhook-queue.ts が担う
 */
export const createGitHubWebhookProcessor =
  (dependencies: GitHubWebhookProcessorDependencies) =>
  async (payload: PullRequestWebhookPayload, delivery: WebhookDelivery): Promise<GitHubWebhookProcessOutcome> => {
    const startedAt = Date.now();
    const deliveryId = delivery.deliveryId;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const author = payload.pullRequest.user.login;
    const context: RequestLogContext = {
      deliveryId,
      githubEvent: "pull_request",
      action: payload.action,
      repository: `${owner}/${repo}`,
      pullRequestNumber: payload.pullRequest.number,
      author,
      installationId: payload.installation.id,
      titleLength: payload.pullRequest.title.length,
    };
    const hardDeadlineSignal =
      dependencies.hardDeadlineSignal ??
      dependencies.createHardDeadlineSignal?.() ??
      AbortSignal.timeout(HARD_DEADLINE_MS);
    const softDeadlineSignal = dependencies.createSoftDeadlineSignal?.() ?? AbortSignal.timeout(SOFT_DEADLINE_MS);
    // signal は soft deadline で止まる通常処理用
    // hardDeadlineSignal を別に渡し、通常処理が止まったあとも status の再収束または fail-closed の投稿を試せるようにする
    const signal = AbortSignal.any([softDeadlineSignal, hardDeadlineSignal]);

    try {
      await postPendingTitleStatus(dependencies, payload, delivery, context, startedAt, signal);

      const outcome = await dependencies.policyUseCase.execute(
        {
          deliveryId,
          action: payload.action,
          titleChanged: payload.changes?.title !== undefined,
          installationId: payload.installation.id,
          owner,
          repo,
          pullRequestNumber: payload.pullRequest.number,
          fallbackHeadSha: payload.pullRequest.head.sha,
          previousHeadSha: payload.action === "synchronize" ? payload.before : undefined,
          author,
          authorType: payload.pullRequest.user.type,
          assignees: payload.pullRequest.assignees.map((assignee) => assignee.login),
        },
        signal,
        hardDeadlineSignal
      );

      for (const warning of outcome.warnings) {
        policyLog(dependencies.logger, "warn", warning.code, context, startedAt, warning.feature);
      }
      for (const feature of outcome.features) {
        if (feature.outcome === "failed") logFeatureFailure(feature, dependencies.logger, context, startedAt);
        else logFeatureResult(feature, dependencies.logger, context, startedAt);
      }
      const failures = outcome.features.filter(
        (feature): feature is Extract<FeatureResult, { outcome: "failed" }> => feature.outcome === "failed"
      );
      if (failures.length > 0) return { status: "failed", errorCode: failureErrorCode(failures) };

      if (outcome.features.length === 0) {
        const result = payload.action === "edited" ? "ignored_edit" : "ignored_action";
        policyLog(dependencies.logger, "info", result, context, startedAt);
        return { status: "processed", result };
      }
      return { status: "processed", result: outcome.result };
    } catch (error) {
      const appError = error instanceof AppError ? error : undefined;
      const configurationError = error instanceof ConfigurationError ? error : undefined;
      policyLog(dependencies.logger, "error", "internal_error", context, startedAt, undefined, {
        errorCode: appError?.code ?? "INTERNAL_ERROR",
        configKey: configurationError?.configKey,
        configReason: configurationError?.reason,
      });
      return { status: "failed", errorCode: appError?.code ?? "INTERNAL_ERROR" };
    }
  };
