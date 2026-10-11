export type AppErrorType =
  | "invalid_request"
  | "role_required"
  | "repo_not_registered"
  | "repo_not_found"
  | "repo_mismatch"
  | "pr_not_found"
  | "pr_not_open"
  | "pr_is_draft"
  | "pr_title_marked_draft"
  | "invalid_pr_title"
  | "pr_recently_updated"
  | "merge_conflict"
  | "merge_blocked"
  | "mergeability_checking"
  | "checks_pending"
  | "checks_failed"
  | "statuses_pending"
  | "statuses_failed"
  | "required_checks_policy_missing"
  | "required_checks_missing"
  | "checks_not_registered"
  | "runs_awaiting_approval"
  | "pull_request_changed"
  | "head_sha_changed"
  | "merge_cooldown"
  | "sync_cooldown"
  | "unexpected_github_error"
  | "unexpected_discord_error"
  | "github_app_permission_missing"
  | "github_rate_limited"
  | "github_rules_api_unavailable";

export class AppError extends Error {
  constructor(
    public readonly type: AppErrorType,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  invalidRequest: (message: string) => new AppError("invalid_request", message),
  roleRequired: () => new AppError("role_required", "Admin role required"),
  repoNotRegistered: () => new AppError("repo_not_registered", "Repository not registered"),
  repoMismatch: () =>
    new AppError("repo_mismatch", "Repository at the registered name is not the registered repository"),
  prNotFound: () => new AppError("pr_not_found", "Pull request not found"),
  prNotOpen: () => new AppError("pr_not_open", "Pull request is not open"),
  prIsDraft: () => new AppError("pr_is_draft", "Pull request is a draft"),
  prTitleMarkedDraft: () => new AppError("pr_title_marked_draft", "Pull request title is marked as draft"),
  invalidPrTitle: (message: string) => new AppError("invalid_pr_title", message),
  prRecentlyUpdated: () => new AppError("pr_recently_updated", "Wait one minute after the last pull request update"),
  mergeConflict: () => new AppError("merge_conflict", "Pull request has merge conflicts"),
  mergeabilityChecking: () =>
    new AppError("mergeability_checking", "GitHub is still calculating mergeability. Try again in about 10 seconds."),
  checksPending: (details: unknown) => new AppError("checks_pending", "Some check runs are still pending", details),
  checksFailed: (details: unknown) => new AppError("checks_failed", "Some check runs did not pass", details),
  statusesPending: (details: unknown) => new AppError("statuses_pending", "Some statuses are still pending", details),
  statusesFailed: (details: unknown) => new AppError("statuses_failed", "Some statuses did not pass", details),
  requiredChecksPolicyMissing: () =>
    new AppError("required_checks_policy_missing", "No required status checks rule applies to the base branch"),
  requiredChecksMissing: (details: unknown) =>
    new AppError(
      "required_checks_missing",
      "Some required status checks are missing or from an unexpected source",
      details
    ),
  checksNotRegistered: () => new AppError("checks_not_registered", "No GitHub Actions check runs have been registered"),
  runsAwaitingApproval: () =>
    new AppError(
      "runs_awaiting_approval",
      "Some action_required workflow runs are still awaiting approval and cannot be auto-approved"
    ),
  pullRequestChanged: () =>
    new AppError("pull_request_changed", "Pull request changed during checks. Retry the merge."),
  headShaChanged: () => new AppError("head_sha_changed", "Head SHA has changed since check"),
  mergeCooldown: () => new AppError("merge_cooldown", "Merge cooldown active. Please wait before retrying."),
  syncCooldown: () => new AppError("sync_cooldown", "Sync cooldown active. Please wait before retrying."),
  unexpectedGithubError: (message: string) => new AppError("unexpected_github_error", message),
  unexpectedDiscordError: (message: string) => new AppError("unexpected_discord_error", message),
  githubAppPermissionMissing: () => new AppError("github_app_permission_missing", "GitHub App permission missing"),
  githubRateLimited: () => new AppError("github_rate_limited", "GitHub API rate limited"),
};
