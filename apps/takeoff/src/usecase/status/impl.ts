import { errors } from "../../domain/errors.js";
import { evaluateMergeGate } from "../../domain/merge-gate.js";
import { nowIso } from "../../domain/time.js";
import { getPullRequestChecksForMergeGate } from "../pull-request-checks.js";
import { getRegisteredPullRequest } from "../registered-pull-request.js";
import { getRequiredStatusChecksForMergeGate } from "../required-status-checks.js";

import type { StatusResult, StatusUsecase, StatusUsecaseParams } from "./interface.js";
import type { RegisteredRepositoryStore } from "../../repository/kv/interface.js";
import type { AutoApproveUsecase } from "../auto-approve/interface.js";
import type { GitHubClient, InstallationTokenProvider } from "../github.js";

export class StatusUsecaseImpl implements StatusUsecase {
  constructor(
    private readonly githubClient: GitHubClient,
    private readonly tokenProvider: InstallationTokenProvider,
    private readonly repoStore: RegisteredRepositoryStore,
    private readonly autoApproveUsecase: AutoApproveUsecase
  ) {}

  async getStatus(params: StatusUsecaseParams): Promise<StatusResult> {
    const repo = await this.repoStore.getRepository(params.repoId);
    if (!repo) throw errors.repoNotRegistered();

    const token = await this.tokenProvider.getToken();
    const pr = await getRegisteredPullRequest(this.githubClient, token, repo, params.prNumber);

    // /merge と同じく、判定より先に承認する
    // 後に回すと「承認前の状態で merge 可」を返した直後に CI が走り出し、表示と実際の状態が食い違う
    const approveResult = await this.autoApproveUsecase.approveActionRequiredRuns(
      token,
      repo.owner,
      repo.name,
      pr.head.sha
    );

    const [pullRequestChecks, requiredStatusChecks] = await Promise.all([
      getPullRequestChecksForMergeGate(this.githubClient, token, repo.owner, repo.name, pr),
      getRequiredStatusChecksForMergeGate(this.githubClient, token, repo.owner, repo.name, pr.base.ref),
    ]);

    let gateResult = evaluateMergeGate(
      pr,
      pullRequestChecks.checkRuns,
      pullRequestChecks.combinedStatus,
      requiredStatusChecks,
      nowIso()
    );

    // 承認した run は check runs にまだ現れていないことがある
    // 承認直後に「merge 可」を返すと利用者が CI 完了前に /merge を打つため、CI 実行待ちとして扱う
    if (gateResult.canMerge && approveResult.approved.length > 0) {
      gateResult = { canMerge: false, error: errors.checksPending({ failedChecks: [] }) };
    } else if (gateResult.canMerge && approveResult.awaitingApproval > 0) {
      // 承認できない action_required run（非メンバー fork PR）が残る場合、required CI がまだ走っていないため merge 不可として扱う
      // /merge も同状況で runs_awaiting_approval で fail-closed する
      gateResult = { canMerge: false, error: errors.runsAwaitingApproval() };
    }

    return {
      gateResult,
      pr,
      repo,
    };
  }
}
