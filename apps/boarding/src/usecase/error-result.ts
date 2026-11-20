import { BoardingError } from "../errors.js";

import type { EvaluationResult } from "./evaluate/interface.js";

export const errorResult = (error: unknown): EvaluationResult => {
  if (error instanceof BoardingError) {
    if (error.code === "SUBREQUEST_LIMIT") return { status: "error", reason: "SUBREQUEST_LIMIT" };
    if (error.code === "INCOMPLETE_PAGINATION") return { status: "error", reason: "INCOMPLETE_DATA" };
  }

  return { status: "error", reason: "API_ERROR" };
};
