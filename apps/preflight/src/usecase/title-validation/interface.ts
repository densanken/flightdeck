export interface ValidatePullRequestTitleCommand {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  fallbackHeadSha: string;
  previousHeadSha?: string;
}

export interface TitleValidationOutcome {
  /**
   * `held` は draft か作業中の接頭辞で検証を保留した状態
   * 共有 head の失敗と区別して alert から外せるようにする
   */
  result: "blocked_shared_head" | "closed" | "held" | "invalid" | "valid";
  comment: "created" | "none" | "updated";
  commentsDeleted: number;
  duplicateCommentsDeleted: number;
  supersededStatusesCleared: number;
  supersededSweepFailed: boolean;
}

export interface ValidatePullRequestTitleUseCase {
  execute(
    command: ValidatePullRequestTitleCommand,
    signal: AbortSignal,
    hardDeadlineSignal?: AbortSignal
  ): Promise<TitleValidationOutcome>;
}
