import type { PolicyGateway } from "@flightdeck/github-policy";
import type { Logger } from "@flightdeck/logger";
import type { PolicyPullRequest, PolicyReview, PolicySettings } from "@flightdeck/rules";

export interface ApprovalGateway extends PolicyGateway {
  authenticate: () => Promise<void>;
  associated: (sha: string, repositoryId: number) => Promise<number[]>;
  search: (date: string) => Promise<Candidate[]>;
  pullRequest: (
    number: number,
    now: number
  ) => Promise<{ repositoryId: number; pr: PolicyPullRequest; queryCost?: number | undefined }>;
  approve: (number: number, sha: string) => Promise<{ status: number; reviewId: number }>;
  dismiss: (number: number, reviewId: number, reason: string) => Promise<{ status: number }>;
  reviewState: (number: number, reviewId: number) => Promise<string>;
  // 現在の実行で消費した subrequest 数
  subrequests: () => number;
}

export interface Candidate {
  number: number;
  authorId: number | null;
  headSha: string;
  // 最新レビューをすべて取得できたか
  reviewsComplete: boolean;
  reviews: PolicyReview[];
}

export interface ApprovalSettings extends PolicySettings {
  botUserId: number;
}

export interface ApprovalDependencies {
  settings: ApprovalSettings;
  github: ApprovalGateway;
  logger: Logger;
  clock: () => number;
  random: () => number;
  maxSubrequests: number;
}
