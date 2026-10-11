import type { MergeGateResult } from "../../domain/merge-gate.js";
import type { RegisteredRepository } from "../../domain/repository.js";
import type { GitHubPullRequest } from "../github.js";

export interface StatusResult {
  gateResult: MergeGateResult;
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
