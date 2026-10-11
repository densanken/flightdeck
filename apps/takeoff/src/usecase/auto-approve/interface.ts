export interface AutoApproveByRunIdParams {
  repoId: string;
  owner: string;
  repo: string;
  runId: number;
  actorLogin: string;
}

export type AutoApproveByRunIdResult =
  { type: "not_registered" } | { type: "evaluated"; approved: boolean; reason: string };

export interface ApprovedRun {
  runId: number;
  name: string;
  actorLogin: string;
}

export interface AutoApprovePendingResult {
  approved: ApprovedRun[];
  // 承認できずに残った action_required pull_request run の件数
  // 非メンバーの fork PR や approve API の 403 で残るものを数える
  awaitingApproval: number;
}

export interface AutoApproveUsecase {
  // 登録済み repository の run だけを対象にする
  autoApproveByRunId(params: AutoApproveByRunIdParams): Promise<AutoApproveByRunIdResult>;
  approveActionRequiredRuns(
    token: string,
    owner: string,
    repo: string,
    headSha: string
  ): Promise<AutoApprovePendingResult>;
}
