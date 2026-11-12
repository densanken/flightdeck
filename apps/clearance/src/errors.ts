// code は処理の保留理由を表し、安全な message だけをログに記録する
export class ClearanceError extends Error {
  constructor(
    readonly code: string,
    readonly errorName: string,
    message: string
  ) {
    super(message);
  }
}

export class BudgetExceeded extends ClearanceError {
  constructor() {
    super("subrequest_limit", "BudgetExceeded", "subrequest limit exceeded");
  }
}

type DataErrorCode = "connection_truncated" | "head_incomplete" | "tree_unavailable" | "graphql_error";

export class GitHubDataError extends ClearanceError {
  constructor(code: DataErrorCode, message: string) {
    super(code, "GitHubDataError", message);
  }
}

// 実行環境の設定が不足または不正な場合
export class ConfigurationError extends Error {}

// status は記録し、detail は既知の plan 制限の判定にだけ使う
export class ApiError extends ClearanceError {
  constructor(
    readonly status: number,
    readonly detail = "",
    readonly rateLimited = false
  ) {
    super("api_error", "ApiError", "GitHub request failed");
  }
}
