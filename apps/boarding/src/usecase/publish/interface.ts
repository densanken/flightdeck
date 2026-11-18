import type { EvaluationResult } from "../evaluate/interface.js";

export interface PublishUseCase {
  execute(input: { number: number }): Promise<EvaluationResult>;
}
