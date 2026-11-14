type DataErrorCode = "connection_truncated" | "head_incomplete" | "tree_unavailable" | "graphql_error";

type GitHubErrorCode = "subrequest_limit" | "time_limit" | "invalid_response" | "timeout" | DataErrorCode | "api_error";

// code は処理の保留理由を表し、安全な message だけをログに記録する
export class GitHubPolicyError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    readonly errorName: string,
    message: string
  ) {
    super(message);
  }
}

export class SubrequestLimitExceeded extends GitHubPolicyError {
  constructor() {
    super("subrequest_limit", "SubrequestLimitExceeded", "subrequest limit exceeded");
  }
}

export class GitHubDataError extends GitHubPolicyError {
  constructor(code: DataErrorCode, message: string) {
    super(code, "GitHubDataError", message);
  }
}

// status は記録し、detail は既知の plan 制限の判定にだけ使う
export class ApiError extends GitHubPolicyError {
  constructor(
    readonly status: number,
    readonly detail = "",
    readonly rateLimited = false
  ) {
    super("api_error", "ApiError", "GitHub request failed");
  }
}

export const errorDetails = (error: unknown) => {
  if (error instanceof GitHubPolicyError) {
    return {
      reasonCode: error.code,
      errorName: error.errorName,
      errorMessage: error.message,
      apiStatus: error instanceof ApiError ? error.status : undefined,
    };
  }

  return {
    reasonCode: "api_error" as const,
    errorName: "Error",
    errorMessage: "GitHub request or review operation failed",
    apiStatus: undefined,
  };
};
