import { ciStatus, decide, errorDetails } from "@flightdeck/github-policy";
import { classify } from "@flightdeck/rules";

import { EXECUTION_TIMEOUT_MS } from "./dependencies.js";

import type { MergeDependencies } from "./dependencies.js";
import type { MergeInput, MergeUseCase } from "./interface.js";
import type { MergeDecision } from "../../domain/merge.js";
import type { PolicyKind, PolicyPullRequest } from "@flightdeck/rules";

// PR の query、設定、tree、source 比較、REST 比較、Rules API、Merge の最大 7 回を確保する
const EVALUATION_RESERVE = 7;

const ciDecision = (ci: "pending" | "blocked"): MergeDecision => ({
  action: ci === "pending" ? "wait" : "block",
  reasonCode: ci === "pending" ? "ci_pending" : "ci_failed",
});

interface EvaluationLog {
  decision: string;
  reasonCode?: string | undefined;
  headSha?: string | undefined;
  policy?: PolicyKind | undefined;
  apiStatus?: number | undefined;
}

export class MergeUseCaseImpl implements MergeUseCase {
  constructor(private readonly dependencies: MergeDependencies) {}

  async execute(input: MergeInput): Promise<void> {
    const { github, logger, clock, maxSubrequests } = this.dependencies;
    const start = clock();
    const fields = {
      delivery_id: input.deliveryId,
      installation_id: input.installationId,
      repository_id: input.repositoryId,
    };

    try {
      await github.authenticate();
      const numbers =
        input.kind === "pull_request"
          ? [input.number]
          : (input.numbers ?? (await github.associated(input.sha, input.repositoryId)));

      for (const number of new Set(numbers)) {
        const reason = (() => {
          if (github.subrequests() > maxSubrequests - EVALUATION_RESERVE) return "subrequest_limit";
          if (clock() - start >= EXECUTION_TIMEOUT_MS) return "time_limit";
          return undefined;
        })();

        if (reason) {
          logger.log("warn", {
            event: "evaluation",
            ...fields,
            pr_number: number,
            decision: "block",
            reason_code: reason,
            subrequests: github.subrequests(),
          });
          return;
        }

        await this.evaluate(input, number);
      }
    } catch (error) {
      const failure = errorDetails(error);
      logger.log("warn", {
        event: "job_failed",
        ...fields,
        reason_code: failure.reasonCode,
        api_status: failure.apiStatus,
        subrequests: github.subrequests(),
      });
    }
  }

  private async mergeDecision(repositoryId: number, pr: PolicyPullRequest): Promise<MergeDecision> {
    const { github, settings, clock } = this.dependencies;
    const policy = await decide(github, repositoryId, pr, settings, clock());

    if (policy.kind !== "allowed") {
      if (policy.kind === "skip") return { action: "skip", reasonCode: policy.reasonCode };
      if (policy.reasonCode === "ci_pending") return { action: "wait", reasonCode: policy.reasonCode };
      return { action: "block", reasonCode: policy.reasonCode };
    }

    const review = pr.reviews.find((item) => item.author?.id === settings.botUserId);
    if (review?.state !== "APPROVED" || review.commitOid !== pr.headSha) {
      return { action: "block", reasonCode: "invalid_review" };
    }

    if (policy.policy === "dispatch") {
      const ci = await ciStatus(github, pr);
      if (ci !== "passed") return ciDecision(ci);
    }

    return { action: "merge", policy: policy.policy, headSha: policy.headSha };
  }

  private async evaluate(input: MergeInput, number: number): Promise<void> {
    const { github, logger, settings, clock } = this.dependencies;
    const fields = {
      delivery_id: input.deliveryId,
      installation_id: input.installationId,
      repository_id: input.repositoryId,
      pr_number: number,
    };
    const log = (value: EvaluationLog) => {
      logger.log("info", {
        event: "evaluation",
        ...fields,
        decision: value.decision,
        reason_code: value.reasonCode,
        head_sha: value.headSha,
        policy: value.policy,
        api_status: value.apiStatus,
        subrequests: github.subrequests(),
      });
    };
    const fetched = await github.pullRequest(number, clock()).catch((error: unknown) => {
      const failure = errorDetails(error);
      log({ decision: "block", reasonCode: failure.reasonCode, apiStatus: failure.apiStatus });
      return undefined;
    });

    if (!fetched) return;

    const { repositoryId, pr } = fetched;
    const policy = classify(pr.author?.id ?? null, settings.dispatchId, settings.renovateIds) ?? undefined;
    const details = { headSha: pr.headSha, policy };

    try {
      if (repositoryId !== input.repositoryId) {
        log({ ...details, decision: "skip", reasonCode: "repository_mismatch" });
        return;
      }
      if (pr.state === "MERGED") {
        log({ ...details, decision: "already_merged", reasonCode: "already_merged" });
        return;
      }
      if (input.kind === "commit" && input.sha !== pr.headSha && input.sha !== pr.mergeSha) {
        log({ ...details, decision: "skip", reasonCode: "sha_mismatch" });
        return;
      }

      const decision = await this.mergeDecision(repositoryId, pr);
      if (decision.action !== "merge") {
        log({ ...details, decision: decision.action, reasonCode: decision.reasonCode });
        return;
      }

      const result = await github.merge(number, decision.headSha);
      log({
        ...details,
        decision: result.merged ? "merged" : "merge_rejected",
        reasonCode: result.merged ? undefined : "merge_rejected",
        policy: decision.policy,
        apiStatus: result.status,
      });
    } catch (error) {
      const failure = errorDetails(error);
      log({ ...details, decision: "block", reasonCode: failure.reasonCode, apiStatus: failure.apiStatus });
    }
  }
}
