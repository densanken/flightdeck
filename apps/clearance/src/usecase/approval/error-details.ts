import { ClearanceError } from "../../errors.js";

// API の本文や入力値はログに出さず、既知の原因だけを記録する
export const errorDetails = (error: unknown): { reasonCode: string; errorName: string; errorMessage: string } => {
  if (error instanceof ClearanceError) {
    return { reasonCode: error.code, errorName: error.errorName, errorMessage: error.message };
  }

  return { reasonCode: "api_error", errorName: "Error", errorMessage: "GitHub request or review operation failed" };
};
