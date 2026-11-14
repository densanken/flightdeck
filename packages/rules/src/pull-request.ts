import type { CheckRun, CommitStatus } from "./ci.js";
import type { Actor, PolicyKind, TimelineItem } from "./policy.js";

export interface PolicyReview {
  id: number | null;
  state: string;
  author: Actor | null;
  commitOid: string | null;
}

export interface PolicyPullRequest {
  state: string;
  draft: boolean;
  body: string;
  createdAt: string;
  branch: string;
  headSha: string;
  // potentialMergeCommit の SHA
  mergeSha: string | null;
  baseBranch: string;
  baseOid: string;
  author: Actor | null;
  editor: Actor | null;
  lastEditedAt: string | null;
  headRepositoryId: number | null;
  labels: string[];
  files: { path: string; changeType: string }[];
  opinionatedReviews: PolicyReview[];
  reviews: PolicyReview[];
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

export interface PolicySettings {
  dispatchId: number;
  renovateIds: number[];
}

export type PolicyDecision =
  | { kind: "allowed"; policy: PolicyKind; headSha: string }
  | { kind: "skip" | "violated" | "undeterminable"; reasonCode: string };
