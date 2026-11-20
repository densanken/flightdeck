import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluationResult } from "../evaluate/interface.js";

export interface WorkflowUseCase {
  execute(pr: PullRequestData, result: EvaluationResult): Promise<void>;
}
