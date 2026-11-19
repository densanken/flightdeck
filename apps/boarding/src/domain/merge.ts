import { evaluateCi } from "@flightdeck/rules";

import { mergeCheckbox, mergeLabel, mergeRequested } from "./merge-request.js";

import type { BodyVersion } from "./merge-request.js";
import type { CheckRun, CommitStatus } from "@flightdeck/rules";

export const authorizationCheckName = "Boarding";

export interface CiData {
  checks: CheckRun[];
  statuses: CommitStatus[];
}

const otherChecks = (checks: CheckRun[], appId: number): CheckRun[] =>
  checks.filter((check) => !(check.name === authorizationCheckName && check.app?.id === appId));

export const hasPendingCi = (ci: CiData | null, appId: number): boolean =>
  ci !== null &&
  (otherChecks(ci.checks, appId).some((check) => check.status !== "completed") ||
    ci.statuses.some((status) => status.state === "pending"));

export interface MergeData {
  draft: boolean;
  body: string;
  ci: CiData | null;
}

export type MergeDecision =
  | { request: "none" }
  | { request: "invalid"; reason: "INVALID_CHECKBOX" | "HISTORY_UNAVAILABLE" | "NOT_AUTHOR" }
  | {
      request: "accepted";
      waiting:
        | "DRAFT"
        | "AUTHORIZATION"
        | "AUTHORS_ONLY"
        | "APP_APPROVAL"
        | "CI_UNAVAILABLE"
        | "CI_PENDING"
        | "CI_FAILED"
        | undefined;
    };

const ciWaiting: Record<ReturnType<typeof evaluateCi>, Extract<MergeDecision, { request: "accepted" }>["waiting"]> = {
  passed: undefined,
  pending: "CI_PENDING",
  blocked: "CI_FAILED",
};

export const decideMerge = (input: {
  data: MergeData;
  versions: BodyVersion[] | null;
  authorId: number;
  allowed: boolean;
  authorRoots: string[];
  otherPaths: string[];
  approved: boolean;
  appId: number;
}): MergeDecision => {
  const data = input.data;
  const checkbox = mergeCheckbox(data.body, mergeLabel);

  if (checkbox === "unchecked") return { request: "none" };
  if (checkbox === "invalid") return { request: "invalid", reason: "INVALID_CHECKBOX" };
  if (!input.versions) return { request: "invalid", reason: "HISTORY_UNAVAILABLE" };
  if (!mergeRequested(input.versions, input.authorId, mergeLabel)) {
    return { request: "invalid", reason: "NOT_AUTHOR" };
  }

  if (data.draft) return { request: "accepted", waiting: "DRAFT" };
  if (input.authorRoots.length === 0 || input.otherPaths.length > 0) {
    return { request: "accepted", waiting: "AUTHORS_ONLY" };
  }
  if (!input.allowed) return { request: "accepted", waiting: "AUTHORIZATION" };
  if (!input.approved) return { request: "accepted", waiting: "APP_APPROVAL" };
  if (!data.ci) return { request: "accepted", waiting: "CI_UNAVAILABLE" };

  const ci = evaluateCi(otherChecks(data.ci.checks, input.appId), data.ci.statuses);
  return { request: "accepted", waiting: ciWaiting[ci] };
};
