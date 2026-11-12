import { STALE_MS } from "@flightdeck/rules";

import { errorDetails } from "./error-details.js";
import { evaluate } from "./evaluate.js";

import type { ApprovalDependencies } from "./dependencies.js";
import type { ApprovalContext, ApprovalUseCase, ReviewCommitInput, ReviewPullRequestsInput } from "./interface.js";

// dispatch PR の Q1、設定、tree、source 比較、REST 比較、Dismiss、Dismiss が 422 のときのレビュー取得の最大 7 回を確保する
const EVALUATION_RESERVE = 7;
const EXECUTION_TIMEOUT_MS = 25_000;

export class ApprovalUseCaseImpl implements ApprovalUseCase {
  constructor(private readonly dependencies: ApprovalDependencies) {}

  reviewPullRequests(input: ReviewPullRequestsInput): Promise<void> {
    return this.review(input, () => Promise.resolve(input.numbers));
  }

  reviewCommit(input: ReviewCommitInput): Promise<void> {
    const { sha, numbers } = input;

    return this.review(
      { ...input, sweep: false, dismissOnly: false },
      () =>
        numbers === undefined ? this.dependencies.github.associated(sha, input.repositoryId) : Promise.resolve(numbers),
      sha
    );
  }

  private async review(
    input: ApprovalContext & { sweep: boolean; dismissOnly: boolean },
    targets: () => Promise<number[]>,
    commitSha?: string
  ): Promise<void> {
    const { settings, github, logger, clock, random, maxSubrequests } = this.dependencies;
    const start = clock();
    const fields = {
      delivery_id: input.deliveryId,
      installation_id: input.installationId,
      repository_id: input.repositoryId,
    };

    try {
      await github.authenticate();

      const numbers = await targets();

      const canStart = () => {
        const reason = (() => {
          if (github.subrequests() > maxSubrequests - EVALUATION_RESERVE) return "subrequest_limit";
          if (clock() - start >= EXECUTION_TIMEOUT_MS) return "time_limit";
          return undefined;
        })();

        if (reason) {
          logger.log("warn", {
            event: "evaluation_deferred",
            ...fields,
            reason_code: reason,
            subrequests: github.subrequests(),
            duration_ms: clock() - start,
          });
        }

        return reason === undefined;
      };

      for (const number of new Set(numbers)) {
        if (!canStart()) return;

        await evaluate(github, number, settings, logger, {
          fields,
          commitSha,
          dismissOnly: input.dismissOnly,
          expectedRepositoryId: input.repositoryId,
          clock,
        });
      }

      if (!input.sweep || !canStart()) return;

      const date = new Date(clock() - STALE_MS).toISOString().slice(0, 10);

      // 対象 PR、Renovate 以外、有効な Approve がある PR は探索しない
      const candidates = (await github.search(date)).filter((pr) => {
        if (numbers.includes(pr.number) || !settings.renovateIds.includes(pr.authorId ?? -1) || !pr.reviewsComplete) {
          return false;
        }

        const latest = pr.reviews.find((review) => review.author?.id === settings.botUserId);
        return latest?.state !== "APPROVED" || latest.commitOid !== pr.headSha;
      });

      if (candidates.length === 0) return;

      // 毎回同じ候補だけを選ばないよう、乱数で決めた位置から最大 5 件を巡回する
      const offset = Math.floor(random() * candidates.length);
      for (const index of candidates.keys()) {
        if (index >= 5 || !canStart()) break;

        const candidate = candidates[(offset + index) % candidates.length];
        if (candidate) {
          await evaluate(github, candidate.number, settings, logger, {
            fields,
            expectedRepositoryId: input.repositoryId,
            clock,
          });
        }
      }
    } catch (error) {
      const failure = errorDetails(error);

      logger.log("warn", {
        event: "job_failed",
        ...fields,
        reason_code: failure.reasonCode,
        error_name: failure.errorName,
        error_message: failure.errorMessage,
        subrequests: github.subrequests(),
        duration_ms: clock() - start,
      });
    }
  }
}
