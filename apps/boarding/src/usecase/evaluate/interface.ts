import type { PullRequestData } from "./dependencies.js";
import type { AuthorizationResult, CommitIdentity } from "../../domain/authorization.js";
import type { Editor } from "../../domain/editors.js";
import type { ManagementRequest } from "../../domain/management.js";
import type { ConsentStatus } from "../../domain/merge-request.js";
import type { MergeDecision } from "../../domain/merge.js";

export type EvaluationResult = (
  | AuthorizationResult
  | { status: "waiting"; reason: "EVALUATING" }
  | { status: "error"; reason: "INCOMPLETE_DATA" | "API_ERROR" | "SUBREQUEST_LIMIT" | "YAML_SIZE_LIMIT" }
) & {
  rootEditors?: { name: string; editors: Editor[] }[] | undefined;
  management?:
    | (ManagementRequest & {
        targets?: Editor[] | undefined;
      })
    | undefined;
  consent?: ConsentStatus | undefined;
  merge?: MergeDecision | undefined;
  mergeOutcome?: "merged" | "changed" | "rejected" | undefined;
  facts?: { authorRoots: string[]; otherPaths: string[]; invalidCommits: CommitIdentity[] } | undefined;
  details?:
    | (NonNullable<AuthorizationResult["details"]> & {
        root?: string | undefined;
      })
    | undefined;
};

export interface EvaluateUseCase {
  execute(input: PullRequestData, request: ManagementRequest, consent: ConsentStatus): Promise<EvaluationResult>;
}
