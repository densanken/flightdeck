import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluateUseCase, EvaluationResult } from "../evaluate/interface.js";

export interface PublishDependencies {
  evaluate: EvaluateUseCase;
  botUserId: number;
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
