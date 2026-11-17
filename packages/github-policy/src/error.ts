import * as v from "valibot";

import { GitHubPolicyError } from "./errors.js";

export const normalizeError = (error: unknown): unknown => {
  if (error instanceof SyntaxError) {
    return new GitHubPolicyError("invalid_response", "SyntaxError", "invalid GitHub response");
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new GitHubPolicyError("timeout", error.name, "GitHub request timed out");
  }

  return error;
};

export const parseResponse = <T extends v.GenericSchema>(schema: T, value: unknown): v.InferOutput<T> => {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new GitHubPolicyError("invalid_response", "ValidationError", "invalid GitHub response");

  return result.output;
};
