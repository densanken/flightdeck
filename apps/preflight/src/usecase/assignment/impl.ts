import { classifyAssignmentNoOp } from "../../domain/assignment.js";
import { triggersAutoAssign } from "../../domain/webhook-actions.js";

import type { AssignmentUseCaseDependencies } from "./dependencies.js";
import type { AssignmentOutcome, AssignPullRequestAuthorCommand, AssignPullRequestAuthorUseCase } from "./interface.js";

export class AssignPullRequestAuthorUseCaseImpl implements AssignPullRequestAuthorUseCase {
  constructor(private readonly dependencies: AssignmentUseCaseDependencies) {}

  async execute(command: AssignPullRequestAuthorCommand, signal: AbortSignal): Promise<AssignmentOutcome> {
    if (!triggersAutoAssign(command.action)) return { result: "ignored_action" };

    const noOpResult = classifyAssignmentNoOp(command, this.dependencies.skipBots);
    if (noOpResult) return { result: noOpResult };

    const assigned = await this.dependencies.githubGateway.assignPullRequestAuthor(command, signal);
    return { result: assigned ? "assigned" : "not_assignable" };
  }
}
