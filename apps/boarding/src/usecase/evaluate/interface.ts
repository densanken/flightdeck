import type { PullRequestData } from "./dependencies.js";
import type { AuthorizationResult } from "../../domain/authorization.js";
import type { CommitIdentity } from "../../domain/commit-identity.js";
import type { Membership } from "../../domain/editors.js";

export type EvaluationResult = (
  | AuthorizationResult
  | { status: "waiting"; reason: "EVALUATING" }
  | { status: "error"; reason: "INCOMPLETE_DATA" | "API_ERROR" | "SUBREQUEST_LIMIT" | "YAML_SIZE_LIMIT" }
) & {
  facts?: { authorRoots: string[]; otherPaths: string[]; invalidCommits: CommitIdentity[] } | undefined;
  details?:
    | (NonNullable<AuthorizationResult["details"]> & {
        root?: string | undefined;
        memberships?: { login: string; orgRole: Membership["orgRole"]; teams: Membership["teams"] }[] | undefined;
      })
    | undefined;
};

export interface EvaluateUseCase {
  execute(input: PullRequestData): Promise<EvaluationResult>;
}
