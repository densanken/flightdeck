import type { Review } from "../../domain/review.js";
import type { Logger } from "@flightdeck/logger";
import type {
  Actor,
  CheckRun,
  CommitStatus,
  ConfigFile,
  GitlinkEntry,
  RequiredStatusCheck,
  TimelineItem,
} from "@flightdeck/rules";

export interface PullRequest {
  state: string;
  draft: boolean;
  body: string;
  createdAt: string;
  branch: string;
  headSha: string;
  // test merge commit の CI event と照合する SHA
  mergeSha: string | null;
  baseBranch: string;
  baseOid: string;
  author: Actor | null;
  editor: Actor | null;
  lastEditedAt: string | null;
  headRepositoryId: number | null;
  labels: string[];
  files: { path: string; changeType: string }[];
  opinionatedReviews: Review[];
  reviews: Review[];
  timeline: TimelineItem[];
  // 取得した timeline の件数との照合に使う
  timelinePageCount: number;
  timelineHasPreviousPage: boolean;
  // 直近 30 日に該当する timeline の件数
  recentCount: number;
  submodules: { path: string; gitUrl: string }[];
  // base の submodule 一覧が最後まで取得できたか
  submodulesComplete: boolean;
  checks: CheckRun[];
  statuses: CommitStatus[];
}

export interface ApprovalGateway {
  authenticate: () => Promise<void>;
  associated: (sha: string, repositoryId: number) => Promise<number[]>;
  search: (date: string) => Promise<Candidate[]>;
  pullRequest: (
    number: number,
    now: number
  ) => Promise<{ repositoryId: number; pr: PullRequest; queryCost?: number | undefined }>;
  configs: (baseOid: string) => Promise<ConfigFile[]>;
  trees: (
    baseOid: string,
    headOid: string,
    path: string
  ) => Promise<{ base: GitlinkEntry | null; head: GitlinkEntry | null }>;
  compare: (source: string, newer: string, older: string) => Promise<{ source: string; ancestry: string }>;
  rules: (branch: string) => Promise<RequiredStatusCheck[]>;
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
  reviews: Review[];
}

export interface PolicySettings {
  dispatchId: number;
  renovateIds: number[];
  botUserId: number;
}

export interface ApprovalDependencies {
  settings: PolicySettings;
  github: ApprovalGateway;
  logger: Logger;
  clock: () => number;
  random: () => number;
  maxSubrequests: number;
}
