export type ErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "REQUEST_TIMEOUT"
  | "INVALID_SIGNATURE"
  | "INVALID_PAYLOAD"
  | "GITHUB_AUTH_FAILED"
  | "GITHUB_API_FAILED"
  | "PULL_REQUEST_STATE_CHANGED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export class RequestTimeoutError extends AppError {
  constructor(message: string, cause: unknown) {
    super("REQUEST_TIMEOUT", 504, message, { cause });
    this.name = "RequestTimeoutError";
  }
}

type ConfigurationErrorReason = "invalid" | "missing";

export class ConfigurationError extends AppError {
  constructor(
    readonly configKey: string,
    readonly reason: ConfigurationErrorReason
  ) {
    super("INTERNAL_ERROR", 500, `Runtime configuration is ${reason}: ${configKey}`);
    this.name = "ConfigurationError";
  }
}

// GitHub が返した error の message と、App の権限不足時に GitHub が示す必要権限
interface GitHubErrorOptions extends ErrorOptions {
  githubMessage?: string;
  acceptedPermissions?: string;
}

export class GitHubError extends AppError {
  readonly githubMessage?: string;
  readonly acceptedPermissions?: string;

  constructor(
    code: "GITHUB_AUTH_FAILED" | "GITHUB_API_FAILED",
    message: string,
    readonly githubStatus?: number,
    readonly githubRequestId?: string,
    readonly retryAfter?: string,
    { githubMessage, acceptedPermissions, ...options }: GitHubErrorOptions = {}
  ) {
    super(code, 502, message, options);
    this.name = "GitHubError";
    this.githubMessage = githubMessage;
    this.acceptedPermissions = acceptedPermissions;
  }
}

export class PullRequestStateChangedError extends AppError {
  constructor() {
    super("PULL_REQUEST_STATE_CHANGED", 502, "Pull request state changed during title validation");
    this.name = "PullRequestStateChangedError";
  }
}
