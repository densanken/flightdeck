import { approvedReviewers } from "../../domain/editors.js";
import { managementRequest, needsBodyHistory, needsManagementHistory } from "../../domain/management.js";
import { consentStatus, needsConsentHistory } from "../../domain/merge-request.js";
import { decideMerge } from "../../domain/merge.js";
import { newAuthorRoots } from "../../domain/paths.js";
import { isContentOnlyAllowed } from "../../domain/workflow.js";
import { errorResult } from "../error-result.js";

import type { PublishDependencies } from "./dependencies.js";
import type { PublishUseCase } from "./interface.js";
import type { BodyVersion } from "../../domain/merge-request.js";
import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluationResult } from "../evaluate/interface.js";

interface Reference {
  number: number;
  baseSha: string;
  headSha: string;
}

interface Approval {
  result: EvaluationResult;
  approved: boolean;
}

interface Evaluation {
  pr: PullRequestData | undefined;
  result: EvaluationResult;
  versions: BodyVersion[] | null;
}

// 管理介入や確認事項の判定は評価の前に必要なので、評価の前に履歴を取得する
const needsEvaluationHistory = (body: string): boolean => needsManagementHistory(body) || needsConsentHistory(body);

export class PublishUseCaseImpl implements PublishUseCase {
  constructor(private readonly dependencies: PublishDependencies) {}

  async execute(input: { number: number; opened?: boolean | undefined }): Promise<EvaluationResult> {
    const current = await this.dependencies.current(input.number);
    if (current.state !== "OPEN" || current.baseBranch !== "main") {
      return { status: "not_applicable", reason: "NO_CONTENT_CHANGES" };
    }

    const ref = { number: input.number, baseSha: current.baseSha, headSha: current.headSha };
    const checkId = await this.dependencies.startCheck({ ...ref, result: { status: "waiting", reason: "EVALUATING" } });
    const evaluated = await this.evaluate(ref);
    const history = await this.mergeHistory(ref.number, evaluated);

    // コメントを Approve より先に投稿するため、Approve が成功する前提で判定する
    // Approve に失敗したときだけ、その結果でコメントを更新する
    const expected = { result: evaluated.result, approved: this.canApprove(evaluated) };
    const commented = await this.comment(ref, this.mergeDecision(evaluated.pr, history, expected));
    const approval = await this.approve(ref, evaluated);
    const result =
      approval.approved === expected.approved
        ? commented
        : await this.comment(ref, this.mergeDecision(evaluated.pr, history, approval));

    await this.dependencies.finishCheck({ ...ref, result, id: checkId });
    // Merge の後に失敗しても Queue の再試行で通知が失われないよう、Merge の前に実行する
    if (evaluated.pr) await this.dependencies.workflow.execute(evaluated.pr, result);
    await this.notify(input, evaluated.pr, evaluated.result);

    return this.merge(ref, result);
  }

  private async evaluate(ref: Reference): Promise<Evaluation> {
    try {
      const pr = await this.dependencies.pullRequest(ref.number);

      if (pr.headSha !== ref.headSha || pr.baseSha !== ref.baseSha || pr.state !== "OPEN" || pr.baseBranch !== "main") {
        return { pr: undefined, versions: null, result: { status: "error", reason: "API_ERROR" } };
      }

      const versions = needsEvaluationHistory(pr.mergeData.body)
        ? await this.bodyVersions(ref.number, pr, this.dependencies.managementBodyVersions)
        : null;
      const request = managementRequest(pr.mergeData.body, versions, pr.author.id);
      const consent = consentStatus(pr.mergeData.body, versions, pr.author.id);
      const result = await this.dependencies.evaluate.execute(pr, request, consent);
      return { pr, versions, result };
    } catch (error) {
      return { pr: undefined, versions: null, result: errorResult(error) };
    }
  }

  private async notify(
    input: { number: number; opened?: boolean | undefined },
    pr: PullRequestData | undefined,
    result: EvaluationResult
  ): Promise<void> {
    if (!input.opened || !pr || result.status === "error") return;

    const names = newAuthorRoots(pr.files, pr.baseRoots);
    const roots = names.map((name) => ({
      name,
      editors: result.rootEditors?.find((root) => root.name === name)?.editors ?? null,
    }));
    if (roots.length === 0) return;

    await this.dependencies.notifyOpened({ number: input.number, author: pr.author.login, roots, result });
  }

  private canApprove({ pr, result }: Evaluation): boolean {
    return pr !== undefined && isContentOnlyAllowed(result);
  }

  private async approve(ref: Reference, evaluated: Evaluation): Promise<Approval> {
    const { pr, result } = evaluated;
    if (!pr || !this.canApprove(evaluated)) {
      return { result, approved: false };
    }

    const approved = approvedReviewers(pr.reviews, ref.headSha, pr.author.id).includes(this.dependencies.botUserId);
    if (approved) return { result, approved: true };

    try {
      await this.dependencies.approve(ref);
      return { result, approved: true };
    } catch (error) {
      return { result: { ...errorResult(error), facts: result.facts }, approved: false };
    }
  }

  private async mergeHistory(number: number, { pr, versions }: Evaluation): Promise<BodyVersion[] | null> {
    if (!pr) return null;

    return needsEvaluationHistory(pr.mergeData.body)
      ? versions
      : await this.bodyVersions(number, pr, this.dependencies.bodyVersions);
  }

  private mergeDecision(
    pr: PullRequestData | undefined,
    history: BodyVersion[] | null,
    { result, approved }: Approval
  ): EvaluationResult {
    if (!pr) return result;

    return {
      ...result,
      merge: decideMerge({
        data: pr.mergeData,
        versions: history,
        authorId: pr.author.id,
        allowed: result.status === "allowed",
        authorRoots: result.facts?.authorRoots ?? [],
        otherPaths: result.facts?.otherPaths ?? [],
        approved,
        appId: this.dependencies.appId,
      }),
    };
  }

  private async bodyVersions(
    number: number,
    pr: PullRequestData,
    load: PublishDependencies["bodyVersions"]
  ): Promise<BodyVersion[] | null> {
    if (!needsBodyHistory(pr.mergeData.body)) return null;

    try {
      return await load({ number, body: pr.mergeData.body, authorId: pr.author.id });
    } catch {
      return null;
    }
  }

  private async merge(ref: Reference, result: EvaluationResult): Promise<EvaluationResult> {
    if (result.merge?.request !== "accepted" || result.merge.waiting) return result;

    const mergeOutcome = await this.dependencies.merge({ number: ref.number, headSha: ref.headSha });
    const merged: EvaluationResult =
      mergeOutcome === "changed"
        ? { ...result, status: "error", reason: "API_ERROR", mergeOutcome }
        : { ...result, mergeOutcome };

    // Merge 済みの最終状態は、closed の webhook でコメントに書く
    // 拒否と直前の変更では PR が Open のままなので、結果をコメントに反映する
    if (mergeOutcome !== "merged") await this.comment(ref, merged);
    return merged;
  }

  private async comment(ref: Reference, result: EvaluationResult): Promise<EvaluationResult> {
    try {
      await this.dependencies.comment({ ...ref, body: this.dependencies.formatComment(result) });
      return result;
    } catch (error) {
      return { ...errorResult(error), facts: result.facts };
    }
  }
}
