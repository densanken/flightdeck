import { errors } from "../../domain/errors.js";
import { evaluateChecksAndStatusGate, evaluateMergeGate, evaluatePullRequestGate } from "../../domain/merge-gate.js";
import { nowIso } from "../../domain/time.js";
import { errorDetail } from "../../util/error-detail.js";
import { getPullRequestChecksForMergeGate } from "../pull-request-checks.js";
import { getRegisteredPullRequest } from "../registered-pull-request.js";
import { getRequiredStatusChecksForMergeGate } from "../required-status-checks.js";

import type { MergeAuditNotifier, MergeResult, MergeUsecase, MergeUsecaseParams } from "./interface.js";
import type { MergeCooldownStore } from "../../repository/cache/interface.js";
import type { RegisteredRepositoryStore } from "../../repository/kv/interface.js";
import type { AutoApproveUsecase } from "../auto-approve/interface.js";
import type { GitHubClient, GitHubMergeResponse, GitHubPullRequest, InstallationTokenProvider } from "../github.js";
import type { PullRequestUsecase } from "../pull-request/interface.js";

export class MergeUsecaseImpl implements MergeUsecase {
  constructor(
    private readonly githubClient: GitHubClient,
    private readonly tokenProvider: InstallationTokenProvider,
    private readonly repoStore: RegisteredRepositoryStore,
    private readonly cooldownCache: MergeCooldownStore,
    private readonly pullRequestUsecase: PullRequestUsecase,
    private readonly auditNotifier: MergeAuditNotifier,
    private readonly autoApproveUsecase: AutoApproveUsecase
  ) {}

  async merge(params: MergeUsecaseParams): Promise<MergeResult> {
    const repo = await this.repoStore.getRepository(params.repoId);
    if (!repo) throw errors.repoNotRegistered();

    // cooldown は colo-local Cache API の best-effort 負荷抑止であり、merge の排他制御には使わない
    // merge safety は後段の Rulesets 再検査と GitHub merge API への head SHA 指定で担保する
    const cooldown = await this.cooldownCache.get(repo.repoId, params.prNumber);
    if (cooldown) throw errors.mergeCooldown();

    const token = await this.tokenProvider.getToken();
    const pr = await getRegisteredPullRequest(this.githubClient, token, repo, params.prNumber);

    const approveResult = await this.autoApproveUsecase.approveActionRequiredRuns(
      token,
      repo.owner,
      repo.name,
      pr.head.sha
    );

    if (approveResult.approved.length > 0) {
      return { type: "auto_approved", approvedRuns: approveResult.approved, pr, repo };
    }

    // 承認できずに残った action_required run（非メンバーの fork PR など）があると
    // CI が未実行のまま merge されうるため、fail-closed で merge を止める
    if (approveResult.awaitingApproval > 0) {
      throw errors.runsAwaitingApproval();
    }

    const [pullRequestChecks, requiredStatusChecks] = await Promise.all([
      getPullRequestChecksForMergeGate(this.githubClient, token, repo.owner, repo.name, pr),
      getRequiredStatusChecksForMergeGate(this.githubClient, token, repo.owner, repo.name, pr.base.ref),
    ]);

    const gateResult = evaluateMergeGate(
      pr,
      pullRequestChecks.checkRuns,
      pullRequestChecks.combinedStatus,
      requiredStatusChecks,
      nowIso()
    );
    if (!gateResult.canMerge) {
      throw gateResult.error;
    }

    await this.cooldownCache.set(repo.repoId, params.prNumber, {
      repoId: repo.repoId,
      prNumber: params.prNumber,
      requestedAt: nowIso(),
      requestedByDiscordUserId: params.discordUserId,
    });

    let freshPr: GitHubPullRequest;
    let mergeResult: GitHubMergeResponse;
    let mergeSignal: AbortSignal | undefined;
    try {
      // まず最新の base branch と PR 状態を読み、check の再取得対象を決める
      freshPr = await getRegisteredPullRequest(this.githubClient, token, repo, params.prNumber);
      if (freshPr.head.sha !== gateResult.headSha) {
        throw errors.headShaChanged();
      }

      const prGateResult = evaluatePullRequestGate(freshPr, nowIso());
      if (!prGateResult.ok) {
        throw prGateResult.error;
      }
      // 初回判定後に conflict が発生する可能性があるため、直前の PR でも mergeable: true を必須にする
      if (freshPr.mergeable === null) {
        throw errors.mergeabilityChecking();
      }
      if (!freshPr.mergeable) {
        throw errors.mergeConflict();
      }

      // 初回 approve 後に同じ head SHA の workflow run が action_required になる場合があるため、merge 直前にも存在検査をやり直す
      // この段階では approve せず、次の明示的な操作へ委ねる
      const freshActionRequiredRuns = await this.githubClient.listActionRequiredRuns(
        token,
        repo.owner,
        repo.name,
        freshPr.head.sha
      );
      if (freshActionRequiredRuns.length > 0) {
        throw errors.runsAwaitingApproval();
      }

      // head / test merge commit の check runs と combined status は再取得し、
      // checks と status の gate を merge 直前に再評価する（fail-closed）
      const [freshPullRequestChecks, freshRequiredStatusChecks] = await Promise.all([
        getPullRequestChecksForMergeGate(this.githubClient, token, repo.owner, repo.name, freshPr),
        getRequiredStatusChecksForMergeGate(this.githubClient, token, repo.owner, repo.name, freshPr.base.ref),
      ]);
      const checksGateResult = evaluateChecksAndStatusGate(
        freshPullRequestChecks.checkRuns,
        freshPullRequestChecks.combinedStatus,
        freshRequiredStatusChecks
      );
      if (!checksGateResult.ok) {
        throw checksGateResult.error;
      }

      // check の再取得中に同じ head SHA のまま PR が更新されることがあるため、
      // status の確認後に最新の PR を取得して update 待機と mergeable を再検査する
      const latestPr = await getRegisteredPullRequest(this.githubClient, token, repo, params.prNumber);
      if (latestPr.head.sha !== gateResult.headSha) {
        throw errors.headShaChanged();
      }
      if (latestPr.base.ref !== freshPr.base.ref || latestPr.base.sha !== freshPr.base.sha) {
        throw errors.pullRequestChanged();
      }
      if ((latestPr.merge_commit_sha ?? null) !== (freshPr.merge_commit_sha ?? null)) {
        throw errors.pullRequestChanged();
      }
      const latestPrGateResult = evaluatePullRequestGate(latestPr, nowIso());
      if (!latestPrGateResult.ok) {
        throw latestPrGateResult.error;
      }
      // GitHub が再計算中で null を返す場合も、安全が確認できないため merge を止めて再試行を求める
      if (latestPr.mergeable === null) {
        throw errors.mergeabilityChecking();
      }
      if (!latestPr.mergeable) {
        throw errors.mergeConflict();
      }
      freshPr = latestPr;

      const remainingMs = params.mergeDeadline - Date.now();
      // 期限ぎりぎりで mutation を開始すると、GitHub 側の成否を確認できなくなるため最低 1 秒は残す
      if (remainingMs < 1_000) {
        throw errors.invalidRequest("マージ前の検証に時間がかかりました。もう一度実行してください。");
      }
      mergeSignal = AbortSignal.timeout(Math.ceil(remainingMs));
      mergeResult = await this.githubClient.mergePullRequest(token, repo.owner, repo.name, params.prNumber, {
        commitTitle: `${freshPr.title} (#${String(freshPr.number)})`,
        sha: gateResult.headSha,
        mergeMethod: "squash",
        signal: mergeSignal,
      });
    } catch (error) {
      const mergeTimedOut = mergeSignal?.aborted;
      // 再検証または merge が失敗した場合は cooldown を解除し、すぐ再試行できるようにする
      await this.cooldownCache.delete(repo.repoId, params.prNumber).catch((deleteError: unknown) => {
        console.error("merge_cooldown_clear_failed", {
          repoId: repo.repoId,
          prNumber: params.prNumber,
          error: errorDetail(deleteError),
        });
      });
      if (mergeTimedOut) {
        throw errors.invalidRequest(
          "マージ結果の確認がタイムアウトしました。GitHub 上で PR の状態を確認してから再度実行してください。"
        );
      }
      throw error;
    }

    const mergedAt = new Date();
    return {
      type: "merged",
      sha: mergeResult.sha,
      pr: freshPr,
      repo,
      mergedAt,
      // 成功通知を終えた呼び出し元が、同じ waitUntil 内で後処理を実行する
      afterMerge: async () => {
        await Promise.all([
          this.auditNotifier
            .notifyMergeAudit({
              discordUserId: params.discordUserId,
              repo: { repoId: repo.repoId, fullName: repo.fullName, htmlUrl: repo.htmlUrl },
              pullRequest: {
                number: freshPr.number,
                title: freshPr.title,
                htmlUrl: freshPr.html_url,
                headRef: freshPr.head.ref,
                baseRef: freshPr.base.ref,
                headSha: freshPr.head.sha,
              },
              merge: { method: "squash", commitSha: mergeResult.sha, mergedAt },
            })
            .catch((error: unknown) => {
              // audit 通知の error には Discord webhook URL（token を含む）が乗る経路があるため、
              // message は記録せず error の name だけを記録する
              console.error("merge_audit_notification_failed", {
                repoId: repo.repoId,
                prNumber: params.prNumber,
                errorName: error instanceof Error ? error.name : typeof error,
              });
            }),
          this.pullRequestUsecase.warmPullRequestListCache(token, repo.owner, repo.name, repo.repoId).catch(() => {
            // cache の再構築に失敗しても merge 自体は完了しているため、error を無視する
          }),
        ]);
      },
    };
  }
}
