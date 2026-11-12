import { describe, expect, it } from "vitest";

import { errorDetails } from "./error-details.js";
import { BudgetExceeded, GitHubDataError } from "../../errors.js";

describe("安全なエラーの記録", () => {
  it("判定不能の原因を区別する", () => {
    expect(errorDetails(new BudgetExceeded()).reasonCode).toBe("subrequest_limit");
    expect(errorDetails(new GitHubDataError("connection_truncated", "CI contexts truncated"))).toEqual({
      reasonCode: "connection_truncated",
      errorName: "GitHubDataError",
      errorMessage: "CI contexts truncated",
    });
    expect(errorDetails(new GitHubDataError("graphql_error", "GraphQL error")).reasonCode).toBe("graphql_error");
  });

  it("想定外の例外本文をログ用の詳細に含めない", () => {
    expect(JSON.stringify(errorDetails(new Error("secret token and PR body")))).not.toContain("secret");
  });
});
