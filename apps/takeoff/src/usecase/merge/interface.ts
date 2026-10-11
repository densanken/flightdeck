import type { RegisteredRepository } from "../../domain/repository.js";
import type { ApprovedRun } from "../auto-approve/interface.js";
import type { GitHubPullRequest } from "../github.js";

export interface MergeAuditPayload {
  discordUserId: string;
  repo: {
    repoId: string;
    fullName: string;
    htmlUrl: string;
  };
  pullRequest: {
    number: number;
    title: string;
    htmlUrl: string;
    headRef: string;
    baseRef: string;
    headSha: string;
  };
  merge: {
    method: "squash";
    commitSha: string;
    mergedAt: Date;
  };
}

export interface MergeAuditNotifier {
  notifyMergeAudit(payload: MergeAuditPayload): Promise<void>;
}

export type MergeResult =
  | { type: "auto_approved"; approvedRuns: ApprovedRun[]; pr: GitHubPullRequest; repo: RegisteredRepository }
  | {
      type: "merged";
      sha: string;
      pr: GitHubPullRequest;
      repo: RegisteredRepository;
      mergedAt: Date;
      afterMerge(): Promise<void>;
    };

export interface MergeUsecaseParams {
  repoId: string;
  prNumber: number;
  discordUserId: string;
  // 成功通知の時間を確保するため、呼び出し元が指定する merge mutation の完了期限
  mergeDeadline: number;
}

export interface MergeUsecase {
  merge(params: MergeUsecaseParams): Promise<MergeResult>;
}
