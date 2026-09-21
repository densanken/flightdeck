export interface AssignPullRequestAuthorCommand {
  action: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  author: string;
  authorType: string;
  assignees: string[];
}

export type AssignmentResult = "assigned" | "not_assignable" | "already_assigned" | "skipped_bot" | "ignored_action";

export interface AssignmentOutcome {
  result: AssignmentResult;
}

export interface AssignPullRequestAuthorUseCase {
  execute(command: AssignPullRequestAuthorCommand, signal: AbortSignal): Promise<AssignmentOutcome>;
}
