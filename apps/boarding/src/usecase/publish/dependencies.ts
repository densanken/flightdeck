import type { BodyVersion } from "../../domain/merge-request.js";
import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluateUseCase, EvaluationResult } from "../evaluate/interface.js";
import type { WorkflowUseCase } from "../workflow/interface.js";

export interface PublishDependencies {
  evaluate: EvaluateUseCase;
  workflow: WorkflowUseCase;
  botUserId: number;
  appId: number;
  managementBodyVersions: (input: { number: number; body: string; authorId: number }) => Promise<BodyVersion[] | null>;
  bodyVersions: (input: { number: number; body: string; authorId: number }) => Promise<BodyVersion[] | null>;
  merge: (input: { number: number; headSha: string }) => Promise<"merged" | "changed" | "rejected">;
  current: (number: number) => Promise<{ state: string; baseBranch: string; baseSha: string; headSha: string }>;
  pullRequest: (number: number) => Promise<PullRequestData>;
  approve: (input: { number: number; baseSha: string; headSha: string }) => Promise<void>;
  comment: (input: { number: number; baseSha: string; headSha: string; body: string }) => Promise<void>;
  formatComment: (result: EvaluationResult) => string;
  startCheck: (input: { number: number; baseSha: string; headSha: string }) => Promise<number>;
  finishCheck: (input: {
    number: number;
    baseSha: string;
    headSha: string;
    id: number;
    result: EvaluationResult;
  }) => Promise<void>;
}
