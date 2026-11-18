import { mergeCheckbox } from "../../domain/merge-request.js";
import { decideMerge } from "../../domain/merge.js";
import { approvedReviewers } from "../../domain/reviews.js";
import { errorResult } from "../error-result.js";

import type { PublishDependencies } from "./dependencies.js";
import type { PublishUseCase } from "./interface.js";
import type { BodyVersion } from "../../domain/merge-request.js";
import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluationResult } from "../evaluate/interface.js";

interface Reference {
  number: number;
  baseSha: string;
  headSha: string;
}

interface Approval {
  result: EvaluationResult;
  approved: boolean;
}

interface Evaluation {
  pr: PullRequestData | undefined;
  result: EvaluationResult;
}

export class PublishUseCaseImpl implements PublishUseCase {
  constructor(private readonly dependencies: PublishDependencies) {}

  async execute(input: { number: number }): Promise<EvaluationResult> {
    const current = await this.dependencies.current(input.number);
    if (current.state !== "OPEN" || current.baseBranch !== "main") {
      return { status: "not_applicable", reason: "NO_CONTENT_CHANGES" };
    }

    const ref = { number: input.number, baseSha: current.baseSha, headSha: current.headSha };
    const checkId = await this.dependencies.startCheck(ref);
    const evaluated = await this.evaluate(ref);
    const approved = await this.approve(ref, evaluated);
    const decision = await this.mergeDecision(ref.number, evaluated.pr, approved);
    const result = await this.comment(ref, decision);

    await this.dependencies.finishCheck({ ...ref, result, id: checkId });
    return this.merge(ref, result);
  }

  private async evaluate(ref: Reference): Promise<Evaluation> {
    try {
      const pr = await this.dependencies.pullRequest(ref.number);

      if (pr.headSha !== ref.headSha || pr.baseSha !== ref.baseSha || pr.state !== "OPEN" || pr.baseBranch !== "main") {
        return { pr: undefined, result: { status: "error", reason: "API_ERROR" } };
      }

      return { pr, result: await this.dependencies.evaluate.execute(pr) };
    } catch (error) {
      return { pr: undefined, result: errorResult(error) };
    }
  }

  private async approve(ref: Reference, evaluated: Evaluation): Promise<Approval> {
    const { pr, result } = evaluated;
    if (result.status !== "allowed" || !pr || result.facts?.otherPaths.length !== 0) {
      return { result, approved: false };
    }

    const approved = approvedReviewers(pr.reviews, ref.headSha, pr.author.id).includes(this.dependencies.botUserId);
    if (approved) return { result, approved: true };

    try {
      await this.dependencies.approve(ref);
      return { result, approved: true };
    } catch (error) {
      return { result: { ...errorResult(error), facts: result.facts }, approved: false };
    }
  }

  private async mergeDecision(
    number: number,
    pr: PullRequestData | undefined,
    approval: Approval
  ): Promise<EvaluationResult> {
    const { result, approved } = approval;
    if (!pr) return result;

    const versions = await this.bodyVersions(number, pr);
    return {
      ...result,
      merge: decideMerge({
        data: pr.mergeData,
        versions,
        authorId: pr.author.id,
        allowed: result.status === "allowed",
        authorRoots: result.facts?.authorRoots ?? [],
        otherPaths: result.facts?.otherPaths ?? [],
        approved,
        appId: this.dependencies.appId,
      }),
    };
  }

  private async bodyVersions(number: number, pr: PullRequestData): Promise<BodyVersion[] | null> {
    if (mergeCheckbox(pr.mergeData.body) !== "checked") return null;

    try {
      return await this.dependencies.bodyVersions({ number, body: pr.mergeData.body, authorId: pr.author.id });
    } catch {
      return null;
    }
  }

  private async merge(ref: Reference, result: EvaluationResult): Promise<EvaluationResult> {
    if (result.merge?.request !== "accepted" || result.merge.waiting) return result;

    const mergeOutcome = await this.dependencies.merge({ number: ref.number, headSha: ref.headSha });
    if (mergeOutcome === "changed") return { ...result, status: "error", reason: "API_ERROR", mergeOutcome };

    return { ...result, mergeOutcome };
  }

  private async comment(ref: Reference, result: EvaluationResult): Promise<EvaluationResult> {
    try {
      await this.dependencies.comment({ ...ref, body: this.dependencies.formatComment(result) });
      return result;
    } catch (error) {
      return { ...errorResult(error), facts: result.facts };
    }
  }
}
