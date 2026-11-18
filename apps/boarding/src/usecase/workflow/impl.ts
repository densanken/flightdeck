import { approvalRepositoryId, approvalRuns } from "../../domain/workflow.js";

import type { WorkflowDependencies } from "./dependencies.js";
import type { WorkflowUseCase } from "./interface.js";
import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluationResult } from "../evaluate/interface.js";

export class WorkflowUseCaseImpl implements WorkflowUseCase {
  constructor(private readonly dependencies: WorkflowDependencies) {}

  async execute(pr: PullRequestData, result: EvaluationResult): Promise<void> {
    const headRepositoryId = approvalRepositoryId({
      crossRepository: pr.isCrossRepository,
      headRepositoryId: pr.headRepositoryId,
      result,
    });
    if (headRepositoryId === null) return;

    const runs = await this.dependencies.list(pr.headSha);
    const eligible = approvalRuns(runs, { headSha: pr.headSha, headRepositoryId, authorId: pr.author.id });
    if (eligible.length > 0) await this.dependencies.approve(eligible);
  }
}
