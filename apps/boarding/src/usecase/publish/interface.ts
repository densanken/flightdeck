import type { EvaluationResult } from "../evaluate/interface.js";

export interface PublishUseCase {
  execute(input: { number: number; opened?: boolean | undefined }): Promise<EvaluationResult>;
}
