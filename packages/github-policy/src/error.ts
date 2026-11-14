import { z } from "zod";

import { GitHubPolicyError } from "./errors.js";

export const normalizeError = (error: unknown): unknown => {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return new GitHubPolicyError(
      "invalid_response",
      error instanceof z.ZodError ? "ZodError" : "SyntaxError",
      "invalid GitHub response"
    );
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new GitHubPolicyError("timeout", error.name, "GitHub request timed out");
  }

  return error;
};

export const parseResponse = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw normalizeError(result.error);

  return result.data;
};
