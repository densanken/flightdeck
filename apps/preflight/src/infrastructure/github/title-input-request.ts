import { githubRequest, readGitHubJson } from "./request.js";

import type { TitleTypeInputsQuery } from "../../usecase/title-validation/dependencies.js";
import type { Logger } from "../../util/logger.js";

export interface TitleInputRequest extends TitleTypeInputsQuery {
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  logger: Logger;
  deliveryId: string;
  remainingInputRequests: () => number;
}

export interface ResolvedTitleInputRequest extends TitleInputRequest {
  root: string;
  baseSha: string;
  changedFiles: number;
}

export class TitleInputBudgetExceededError extends Error {}

export const logTitleInputWarning = (input: TitleInputRequest, result: string, reason?: string): void => {
  input.logger.log("warn", {
    event: "github_webhook_consume",
    feature: "title-validation",
    result,
    deliveryId: input.deliveryId,
    pullRequestNumber: input.pullRequestNumber,
    reason,
  });
};

const hasInputBudget = (input: TitleInputRequest): boolean => {
  if (input.remainingInputRequests() > 0) return true;

  logTitleInputWarning(input, "title_type_inputs_budget_exceeded");

  return false;
};

export const titleInputRequest = async (input: TitleInputRequest, url: string, body?: unknown): Promise<unknown> => {
  const response = await githubRequest({
    url,
    method: body === undefined ? "GET" : "POST",
    body,
    token: input.installationToken,
    expectedStatuses: [200],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    beforeAttempt: () => {
      if (!hasInputBudget(input)) throw new TitleInputBudgetExceededError();
    },
  });

  return readGitHubJson(response, "GITHUB_API_FAILED", input.signal);
};
