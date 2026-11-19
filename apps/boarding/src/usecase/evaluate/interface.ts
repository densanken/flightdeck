import type { PullRequestData } from "./dependencies.js";
import type { AuthorizationResult } from "../../domain/authorization.js";
import type { CommitIdentity } from "../../domain/commit-identity.js";
import type { Editor, Membership } from "../../domain/editors.js";
import type { ManagementRequest } from "../../domain/management.js";
import type { MergeDecision } from "../../domain/merge.js";

export type EvaluationResult = (
  | AuthorizationResult
  | { status: "waiting"; reason: "EVALUATING" }
  | { status: "error"; reason: "INCOMPLETE_DATA" | "API_ERROR" | "SUBREQUEST_LIMIT" | "YAML_SIZE_LIMIT" }
) & {
  management?:
    | (ManagementRequest & {
        targets?: Editor[] | undefined;
        approvers?: Membership[] | undefined;
      })
    | undefined;
  merge?: MergeDecision | undefined;
  mergeOutcome?: "merged" | "changed" | "rejected" | undefined;
  facts?: { authorRoots: string[]; otherPaths: string[]; invalidCommits: CommitIdentity[] } | undefined;
  details?:
    | (NonNullable<AuthorizationResult["details"]> & {
        root?: string | undefined;
        memberships?: Membership[] | undefined;
      })
    | undefined;
};

export interface EvaluateUseCase {
  execute(input: PullRequestData, request: ManagementRequest): Promise<EvaluationResult>;
}
