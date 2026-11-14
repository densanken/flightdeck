import { describe, expect, it } from "vitest";

import { ApiError, SubrequestLimitExceeded, errorDetails, GitHubDataError, GitHubPolicyError } from "./errors.js";

describe("安全なエラー情報", () => {
  it("既知のエラーコードと HTTP status を保持する", () => {
    expect(errorDetails(new SubrequestLimitExceeded())).toMatchObject({ reasonCode: "subrequest_limit" });
    expect(errorDetails(new GitHubDataError("connection_truncated", "CI contexts truncated"))).toMatchObject({
      reasonCode: "connection_truncated",
      errorName: "GitHubDataError",
      errorMessage: "CI contexts truncated",
    });
    expect(errorDetails(new ApiError(403))).toMatchObject({ reasonCode: "api_error", apiStatus: 403 });
    expect(errorDetails(new GitHubPolicyError("timeout", "TimeoutError", "GitHub request timed out"))).toMatchObject({
      reasonCode: "timeout",
    });
  });

  it("想定外の例外本文と偽のエラー情報を出力しない", () => {
    const error = Object.assign(new Error("secret token and PR body"), { code: "timeout", status: 403 });
    expect(errorDetails(error)).toEqual({
      reasonCode: "api_error",
      errorName: "Error",
      errorMessage: "GitHub request or review operation failed",
      apiStatus: undefined,
    });
  });
});
