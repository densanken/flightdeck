export interface ApprovalContext {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  repository: string;
}

export interface ReviewPullRequestsInput extends ApprovalContext {
  numbers: number[];
  sweep: boolean;
  // true なら Approve せず、条件違反の Dismiss だけを行う
  dismissOnly: boolean;
}

export interface ReviewCommitInput extends ApprovalContext {
  sha: string;
  // check_suite が示す PR。指定がなければ commit に関連する open PR を取得する
  numbers?: number[];
}

export interface ApprovalUseCase {
  // PR の操作を契機に指定された PR を評価し、sweep が有効なら古い Renovate PR も探索する
  reviewPullRequests(input: ReviewPullRequestsInput): Promise<void>;
  // CI の結果を契機に、SHA が一致する PR を評価する
  reviewCommit(input: ReviewCommitInput): Promise<void>;
}
