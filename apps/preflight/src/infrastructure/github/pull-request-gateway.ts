import { confirmSweepCommits, listPullRequestCommitTitleStatuses, setPullRequestTitleStatus } from "./commit-status.js";
import { createIssueComment, deleteIssueComment, listIssueComments, updateIssueComment } from "./issue-comments.js";
import { addPullRequestAuthorAsAssignee } from "./pull-request-assignee.js";
import { getCurrentPolicyState, listOpenPullRequestsForHeadShas } from "./pull-requests.js";

import type { GitHubInstallationSession } from "./installation-session.js";
import type { AssignPullRequestAuthorInput, GitHubAssignmentGateway } from "../../usecase/assignment/dependencies.js";
import type {
  AssociatedPullRequestTitle,
  IssueComment,
  PullRequestCommitTitleStatus,
  TitleStatusState,
  TitleValidationGateway,
} from "../../usecase/title-validation/dependencies.js";
import type { Logger } from "../../util/logger.js";

export class GitHubPullRequestGatewayImpl implements GitHubAssignmentGateway, TitleValidationGateway {
  constructor(
    private readonly session: GitHubInstallationSession,
    private readonly logger: Logger,
    // 全 open PR fallback の totalCount 不一致警告に付け、同じ delivery の他の github_webhook_consume log と相関できるようにする
    private readonly deliveryId: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  async assignPullRequestAuthor(input: AssignPullRequestAuthorInput, signal: AbortSignal): Promise<boolean> {
    const result = await addPullRequestAuthorAsAssignee({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
    return result.assigned;
  }

  async getCurrentPolicyState(
    input: { owner: string; repo: string; pullRequestNumber: number; headSha: string },
    signal: AbortSignal
  ): ReturnType<TitleValidationGateway["getCurrentPolicyState"]> {
    return getCurrentPolicyState({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }

  async listOpenPullRequestsForHeadShas(
    input: { owner: string; repo: string; headShas: string[] },
    signal: AbortSignal
  ): Promise<AssociatedPullRequestTitle[]> {
    return listOpenPullRequestsForHeadShas({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
      logger: this.logger,
      deliveryId: this.deliveryId,
    });
  }

  getAuthenticatedAppBotUserId(signal: AbortSignal): Promise<number> {
    return this.session.getAuthenticatedAppBotUserId(signal);
  }

  async listPullRequestCommitTitleStatuses(
    input: { owner: string; repo: string; pullRequestNumber: number; maxPages: number },
    signal: AbortSignal
  ): Promise<PullRequestCommitTitleStatus[]> {
    return listPullRequestCommitTitleStatuses({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
      logger: this.logger,
      deliveryId: this.deliveryId,
    });
  }

  async confirmSweepCommits(
    input: { owner: string; repo: string; shas: string[] },
    signal: AbortSignal
  ): ReturnType<TitleValidationGateway["confirmSweepCommits"]> {
    return confirmSweepCommits({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }

  async setTitleStatus(
    input: {
      owner: string;
      repo: string;
      sha: string;
      state: TitleStatusState;
      description: string;
      targetUrl?: string;
      retry?: boolean;
    },
    signal: AbortSignal
  ): Promise<void> {
    await setPullRequestTitleStatus({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }

  async listIssueComments(
    input: { owner: string; repo: string; pullRequestNumber: number },
    signal: AbortSignal
  ): Promise<IssueComment[]> {
    return listIssueComments({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }

  async createIssueComment(
    input: { owner: string; repo: string; pullRequestNumber: number; body: string },
    signal: AbortSignal
  ): Promise<void> {
    await createIssueComment({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }

  async updateIssueComment(
    input: { owner: string; repo: string; commentId: number; body: string },
    signal: AbortSignal
  ): Promise<void> {
    await updateIssueComment({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }

  async deleteIssueComment(
    input: { owner: string; repo: string; commentId: number },
    signal: AbortSignal
  ): Promise<void> {
    await deleteIssueComment({
      ...input,
      installationToken: await this.session.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }
}
