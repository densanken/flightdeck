// 1 ページ 100 件で 600 件相当。上限を超える場合は一覧を確定できなかった失敗とする
export const MAX_OPEN_PULL_REQUEST_PAGES = 6;

// commit status は context ごとに最新の 1 件だけが評価される
// pending へ戻せるのは check run に無い性質
export type TitleStatusState = "error" | "failure" | "pending" | "success";

/**
 * `PR Title` status の読み取り結果
 * GitHub GraphQL の enum 表現は adapter 内で正規化する
 */
export type ObservedTitleStatusState = "not_success" | "success";

export interface IssueComment {
  id: number;
  body: string | null;
  user: { id: number } | null;
}

export interface PullRequestTitleState {
  title: string;
  headSha: string;
  state: "closed" | "open";
  draft: boolean;
}

export interface AssociatedPullRequestTitle {
  number: number;
  title: string;
  headSha: string;
  draft: boolean;
}

export interface PullRequestCommitTitleStatus {
  sha: string;
  /**
   * `PR Title` context の state
   * status が無ければ null
   */
  statusState: ObservedTitleStatusState | null;
}

export interface TitleValidationGateway {
  readonly getCurrentPolicyState: (
    input: { owner: string; repo: string; pullRequestNumber: number; headSha: string },
    signal: AbortSignal
  ) => Promise<{
    current: PullRequestTitleState;
    associatedPullRequests: AssociatedPullRequestTitle[] | undefined;
  }>;
  readonly listOpenPullRequestsForHeadShas: (
    input: { owner: string; repo: string; headShas: string[] },
    signal: AbortSignal
  ) => Promise<AssociatedPullRequestTitle[]>;
  readonly getAuthenticatedAppBotUserId: (signal: AbortSignal) => Promise<number>;
  readonly listPullRequestCommitTitleStatuses: (
    input: { owner: string; repo: string; pullRequestNumber: number; maxPages: number },
    signal: AbortSignal
  ) => Promise<PullRequestCommitTitleStatus[]>;
  readonly confirmSweepCommits: (
    input: { owner: string; repo: string; shas: string[] },
    signal: AbortSignal
  ) => Promise<Map<string, AssociatedPullRequestTitle[] | undefined>>;
  readonly setTitleStatus: (
    input: {
      owner: string;
      repo: string;
      sha: string;
      state: TitleStatusState;
      description: string;
      targetUrl?: string;
      retry?: boolean;
    },
    signal: AbortSignal
  ) => Promise<void>;
  readonly listIssueComments: (
    input: { owner: string; repo: string; pullRequestNumber: number },
    signal: AbortSignal
  ) => Promise<IssueComment[]>;
  readonly createIssueComment: (
    input: { owner: string; repo: string; pullRequestNumber: number; body: string },
    signal: AbortSignal
  ) => Promise<void>;
  readonly updateIssueComment: (
    input: { owner: string; repo: string; commentId: number; body: string },
    signal: AbortSignal
  ) => Promise<void>;
  readonly deleteIssueComment: (
    input: { owner: string; repo: string; commentId: number },
    signal: AbortSignal
  ) => Promise<void>;
}

export interface TitleValidationPhases {
  sweep: TitleValidationGateway;
  recovery: TitleValidationGateway;
  recoveryStatus: TitleValidationGateway;
  budget: { remaining: (phase: "sweep" | "recovery" | "recovery_status") => number };
  log: (result: string, count: number, sha?: string) => void;
}
