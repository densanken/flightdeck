import { logger } from "../../util/logger.js";

import type {
  AutoApproveByRunIdParams,
  AutoApproveByRunIdResult,
  AutoApprovePendingResult,
  AutoApproveUsecase,
  ApprovedRun,
} from "./interface.js";
import type { RegisteredRepositoryStore } from "../../repository/kv/interface.js";
import type { GitHubClient, InstallationTokenProvider } from "../github.js";

export class AutoApproveUsecaseImpl implements AutoApproveUsecase {
  constructor(
    private readonly client: GitHubClient,
    private readonly tokenProvider: InstallationTokenProvider,
    private readonly repoStore: RegisteredRepositoryStore,
    private readonly githubOrg: string
  ) {}

  async autoApproveByRunId({
    repoId,
    owner,
    repo,
    runId,
    actorLogin,
  }: AutoApproveByRunIdParams): Promise<AutoApproveByRunIdResult> {
    const registered = await this.repoStore.getRepository(repoId);
    if (!registered) return { type: "not_registered" };

    const token = await this.tokenProvider.getToken();
    const isMember = await this.client.isOrgMember(token, this.githubOrg, actorLogin);
    if (!isMember) {
      return { type: "evaluated", approved: false, reason: `${actorLogin} is not a member of ${this.githubOrg}` };
    }
    const approved = await this.client.approveWorkflowRun(token, owner, repo, runId);
    if (approved) {
      return { type: "evaluated", approved: true, reason: `Approved run ${String(runId)} by ${actorLogin}` };
    }
    return { type: "evaluated", approved: false, reason: `Run ${String(runId)} could not be approved (403)` };
  }

  async approveActionRequiredRuns(
    token: string,
    owner: string,
    repo: string,
    headSha: string
  ): Promise<AutoApprovePendingResult> {
    const runs = await this.client.listActionRequiredRuns(token, owner, repo, headSha);
    // membership 判定が途中で失敗したときに、承認済みの run が残ったままエラーを返さないよう、承認は全 run の判定後に行う
    const memberCache = new Map<string, boolean>();
    for (const run of runs) {
      const login = run.actor.login;
      if (!memberCache.has(login)) {
        memberCache.set(login, await this.client.isOrgMember(token, this.githubOrg, login));
      }
    }

    const approved: ApprovedRun[] = [];
    let awaitingApproval = 0;
    for (const run of runs) {
      const login = run.actor.login;
      if (!memberCache.get(login)) {
        awaitingApproval += 1;
        continue;
      }

      if (await this.client.approveWorkflowRun(token, owner, repo, run.id)) {
        // 承認の結果を利用者へ伝える応答が失敗しても、どの run を承認したかを追えるようにする
        logger.log("info", {
          event: "workflow_run_approved",
          repository: `${owner}/${repo}`,
          headSha,
          runId: run.id,
          runName: run.name,
          actorLogin: login,
        });
        approved.push({ runId: run.id, name: run.name, actorLogin: login });
      } else {
        awaitingApproval += 1;
      }
    }

    return { approved, awaitingApproval };
  }
}
