import { approvedReviewers } from "../../domain/reviews.js";
import { errorResult } from "../error-result.js";

import type { PublishDependencies } from "./dependencies.js";
import type { PublishUseCase } from "./interface.js";
import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluationResult } from "../evaluate/interface.js";

interface Reference {
  number: number;
  baseSha: string;
  headSha: string;
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
    const result = await this.comment(ref, approved);

    await this.dependencies.finishCheck({ ...ref, result, id: checkId });

    return result;
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

  private async approve(ref: Reference, evaluated: Evaluation): Promise<EvaluationResult> {
    try {
      if (
        evaluated.result.status === "allowed" &&
        evaluated.pr &&
        evaluated.result.facts?.otherPaths.length === 0 &&
        !approvedReviewers(evaluated.pr.reviews, ref.headSha, evaluated.pr.author.id).includes(
          this.dependencies.botUserId
        )
      ) {
        await this.dependencies.approve(ref);
      }

      return evaluated.result;
    } catch (error) {
      return { ...errorResult(error), facts: evaluated.result.facts };
    }
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
