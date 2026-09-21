import { isRecord, positiveSafeInteger } from "../../util/type-guards.js";

export interface PullRequestWebhookPayload {
  action: string;
  before?: string;
  changes?: { title?: { from?: string } };
  installation: { id: number };
  repository: { name: string; owner: { login: string } };
  pullRequest: {
    number: number;
    title: string;
    head: { sha: string };
    user: { login: string; type: string };
    assignees: { login: string }[];
  };
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export const parsePullRequestWebhookPayload = (value: unknown): PullRequestWebhookPayload | null => {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  if (value.before !== undefined && !nonEmptyString(value.before)) return null;

  const installation = value.installation;
  const repository = value.repository;
  const pullRequest = value.pull_request;
  if (!isRecord(installation) || !positiveSafeInteger(installation.id)) return null;
  if (!isRecord(repository) || !nonEmptyString(repository.name) || !isRecord(repository.owner)) return null;
  if (!nonEmptyString(repository.owner.login)) return null;
  if (!isRecord(pullRequest) || !positiveSafeInteger(pullRequest.number) || !isRecord(pullRequest.user)) return null;
  if (!nonEmptyString(pullRequest.user.login) || !nonEmptyString(pullRequest.user.type)) return null;
  if (typeof pullRequest.title !== "string" || !isRecord(pullRequest.head) || !nonEmptyString(pullRequest.head.sha)) {
    return null;
  }

  let parsedChanges: PullRequestWebhookPayload["changes"];
  if (value.changes !== undefined) {
    if (!isRecord(value.changes)) return null;
    if (value.changes.title !== undefined) {
      if (!isRecord(value.changes.title)) return null;
      if (value.changes.title.from !== undefined && typeof value.changes.title.from !== "string") return null;
      parsedChanges = {
        title: value.changes.title.from === undefined ? {} : { from: value.changes.title.from },
      };
    }
  }

  const assigneesValue = pullRequest.assignees;
  if (assigneesValue !== undefined && !Array.isArray(assigneesValue)) return null;
  const parsedAssignees: { login: string }[] = [];
  for (const assignee of (assigneesValue ?? []) as unknown[]) {
    if (!isRecord(assignee) || !nonEmptyString(assignee.login)) return null;
    parsedAssignees.push({ login: assignee.login });
  }

  return {
    action: value.action,
    before: value.before,
    changes: parsedChanges,
    installation: { id: installation.id },
    repository: { name: repository.name, owner: { login: repository.owner.login } },
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      head: { sha: pullRequest.head.sha },
      user: { login: pullRequest.user.login, type: pullRequest.user.type },
      assignees: parsedAssignees,
    },
  };
};
