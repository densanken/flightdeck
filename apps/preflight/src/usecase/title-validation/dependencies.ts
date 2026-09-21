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
  isOpenPullRequestHead: boolean;
  /** 関連 PR が多すぎて open head かどうかを判定しきれなかった */
  associatedPullRequestsTruncated: boolean;
}

export interface TitleValidationGateway {
  readonly getCurrentPullRequestTitleState: (
    input: { owner: string; repo: string; pullRequestNumber: number },
    signal: AbortSignal
  ) => Promise<PullRequestTitleState>;
  readonly listOpenPullRequestsForHeadSha: (
    input: { owner: string; repo: string; headSha: string },
    signal: AbortSignal
  ) => Promise<AssociatedPullRequestTitle[]>;
  readonly getAuthenticatedAppBotUserId: (signal: AbortSignal) => Promise<number>;
  readonly listPullRequestCommitTitleStatuses: (
    input: { owner: string; repo: string; pullRequestNumber: number },
    signal: AbortSignal
  ) => Promise<PullRequestCommitTitleStatus[]>;
  readonly setTitleStatus: (
    input: {
      owner: string;
      repo: string;
      sha: string;
      state: TitleStatusState;
      description: string;
      targetUrl?: string;
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
