import type { MergeGateResult } from "../../domain/merge-gate.js";
import type { RegisteredRepository } from "../../domain/repository.js";
import type { ForkWorkflowDrift } from "../fork-workflow-drift.js";
import type { GitHubPullRequest } from "../github.js";

export interface StatusResult {
  gateResult: MergeGateResult;
  // fork の .github/workflows が base と食い違い、/merge が GitHub に拒否される状態
  // merge 可否の判定には含めず、利用者への注意としてだけ使う
  forkWorkflowDrift: ForkWorkflowDrift;
  pr: GitHubPullRequest;
  repo: RegisteredRepository;
}

export interface StatusUsecaseParams {
  repoId: string;
  prNumber: number;
}

export interface StatusUsecase {
  getStatus(params: StatusUsecaseParams): Promise<StatusResult>;
}
