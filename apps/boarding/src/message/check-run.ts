import { guidance } from "./authorization.js";
import { reasonLabels } from "./status.js";

import type { EvaluationResult } from "../usecase/evaluate/interface.js";

export interface CheckOutput {
  title: string;
  summary: string;
}

export const checkOutput = (result: EvaluationResult): CheckOutput => ({
  title: reasonLabels[result.reason],
  summary:
    result.reason === "EVALUATING"
      ? `${guidance[result.reason]}評価の完了をお待ちください。`
      : `${guidance[result.reason]}詳しくは PR の管理コメントを確認してください。`,
});
