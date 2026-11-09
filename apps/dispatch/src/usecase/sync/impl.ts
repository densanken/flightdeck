import { chooseConfig, parseConfig } from "../../domain/config.js";
import { normalizeGitHubUrl } from "../../domain/gitmodules.js";
import { isAutoclosed, managedBranchName, sourceOf, updateTitle, withAutoclosedSuffix } from "../../domain/naming.js";
import { pullRequestBody, withoutCommitList } from "../../domain/pull-request-body.js";
import { isUpToDate, planPullRequests } from "../../domain/sync-decision.js";
import { DispatchError, isPermanent } from "../../errors.js";

import type {
  ChildMessage,
  ClosedPullRequest,
  DispatchGateway,
  OpenPullRequest,
  ParentState,
  RepositoryState,
  SyncDependencies,
} from "./dependencies.js";
import type { SyncUseCase } from "./interface.js";
import type { ConfigFile, Target } from "../../domain/config.js";
import type { Logger } from "../../util/logger.js";

// parent base の変化や CAS の競合、PR を Open に戻した後に状態を取り直す上限
const MAX_ATTEMPTS = 4;

interface SourceSnapshot {
  fullName: string;
  defaultBranch: string;
  // 処理時点の default branch HEAD
  // 設定と gitlink はこの SHA に揃える
  sha: string;
}

type SyncOutcome = "created" | "updated" | "unchanged" | "autoclosed";
// retry は、処理中に状態が変わった（base や source の進行、CAS の競合）か、PR を Open に戻したため、状態を取り直すことを表す
type AttemptResult = SyncOutcome | "retry";

// 存在する共有の設定ファイル（flightdeck.yml と flightdeck.yaml）から、使ったファイルの path と target の一覧を作る
// ファイルがなければ undefined、dispatch の section がなければ target は空
// 両方あれば設定エラー
const readConfig = (configs: ConfigFile[]): { path: string; targets: Target[] } | undefined => {
  const file = chooseConfig(configs);

  return file === undefined ? undefined : { path: file.path, targets: parseConfig(file.text) };
};

const targetsOf = (configs: ConfigFile[]): Target[] => readConfig(configs)?.targets ?? [];

// 設定の repository は parent の現在の正規名で書く（rename 前の名前は同期の時点で設定エラーになる）
const findTargetFor = (targets: Target[], repository: string): Target | undefined =>
  targets.find((target) => target.repository.toLowerCase() === repository.toLowerCase());

const snapshotOf = (state: RepositoryState): SourceSnapshot | undefined =>
  state.sha
    ? { fullName: state.repository.fullName, defaultBranch: state.repository.defaultBranch, sha: state.sha }
    : undefined;

// parent が target の前提（正規名、base branch、gitlink、.gitmodules の URL）を満たすか確かめ、同期に使う base を返す
// 満たさなければ設定エラー
const baseOf = (state: ParentState, target: Target, source: SourceSnapshot) => {
  const parent = state.repository.fullName;
  if (parent.toLowerCase() !== target.repository.toLowerCase()) {
    throw new DispatchError("config", `use the current repository name: ${parent}`);
  }

  const base = state.base;
  if (!base) {
    throw new DispatchError(
      "config",
      `base branch not found: ${parent}#${target.baseBranch ?? state.repository.defaultBranch}`
    );
  }

  const previousSha = base.gitlinkSha;
  if (!previousSha) throw new DispatchError("config", `path is not a gitlink: ${parent}:${target.path}`);

  const submodule = base.submodules.find((candidate) => candidate.path === target.path);
  if (!submodule) throw new DispatchError("config", `.gitmodules has no submodule: ${parent}:${target.path}`);
  if (normalizeGitHubUrl(submodule.url) !== source.fullName.toLowerCase()) {
    throw new DispatchError("config", `.gitmodules does not match ${source.fullName}: ${parent}:${target.path}`);
  }

  return { ...base, previousSha };
};

// 旧設定を読めない場合は cleanup を推測せず、最新設定の適用だけを行う
// 理由があれば skipped に返す
// 設定ファイルが元からない repo では、旧設定は空で、理由は付かない
const readPreviousTargets = (previous: RepositoryState["previous"]): { targets: Target[]; skipped?: string } => {
  if (!previous) return { targets: [], skipped: "previous ref not available" };

  try {
    return { targets: targetsOf(previous.configs) };
  } catch {
    return { targets: [], skipped: "previous config is unusable" };
  }
};

export class SyncUseCaseImpl implements SyncUseCase {
  private readonly gateway: DispatchGateway;
  private readonly enqueue: SyncDependencies["enqueue"];
  private readonly logger: Logger;

  constructor({ gateway, enqueue, logger }: SyncDependencies) {
    this.gateway = gateway;
    this.enqueue = enqueue;
    this.logger = logger;
  }

  async handlePush({
    repository,
    branch,
    before,
  }: {
    repository: string;
    branch: string;
    before?: string;
  }): Promise<void> {
    const state = await this.gateway.readRepositoryState(repository, {
      previous: before === undefined ? undefined : { sha: before },
      withManaged: true,
    });

    if (branch === state.repository.defaultBranch) await this.enqueueSource(state);
    await this.enqueueParent(state, branch);
  }

  async handleDefaultBranchChanged({
    repository,
    previousDefaultBranch,
  }: {
    repository: string;
    previousDefaultBranch: string;
  }): Promise<void> {
    const state = await this.gateway.readRepositoryState(repository, {
      previous: { branch: previousDefaultBranch },
      withManaged: true,
    });

    await this.enqueueSource(state);
    await this.enqueueParent(state);
  }

  // target を 1 件同期する
  // 取り直すたびに、その間に進んだ source の HEAD と設定を読み直す（古い SHA へ戻さない）
  // 設定から target が消えていたら（parent の push、管理 branch の push、PR の event で、設定にない parent だった場合を含む）、更新せずに止める
  async syncTarget({ source: sourceName, target: targetName }: { source: string; target: string }): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const state = await this.gateway.readRepositoryState(sourceName);
      const source = snapshotOf(state);
      const config = source ? readConfig(state.configs) : undefined;
      const target = config ? findTargetFor(config.targets, targetName) : undefined;

      if (!source || !config || !target) {
        this.logger.log("info", { event: "target_skipped", source: sourceName, parent: targetName });

        return;
      }

      const outcome = await this.attemptSync(source, target, config.path);
      if (outcome !== "retry") {
        this.logger.log("info", { event: "target_synced", source: source.fullName, parent: targetName, outcome });

        return;
      }
    }

    throw new DispatchError("retryable", `parent state kept changing: ${targetName}`);
  }

  // 管理 branch を head とする Open PR を Close する
  // 直前に設定を読み直し、
  // 読んでから Close するまでの間に target が設定へ戻され、新しい run が同期した PR を閉じないようにする
  async closeTarget({ source, target }: { source: string; target: string }): Promise<void> {
    const { fullName, pullRequests } = await this.gateway.readManagedPullRequests(target, managedBranchName(source));
    if (pullRequests.length === 0) return;

    const latest = await this.gateway.readRepositoryState(source);
    if (findTargetFor(targetsOf(latest.configs), fullName)) {
      this.logger.log("info", {
        event: "close_skipped",
        source,
        parent: fullName,
        reason: "target is configured again",
      });

      return;
    }

    await this.autoclose(fullName, pullRequests);
    this.logger.log("info", { event: "target_removed", source, parent: fullName, closed: pullRequests.length });
  }

  // source の役割: 設定の target ごとと、設定から消えた target ごとに、子 message を積む
  // 設定が不正なら、この役割だけを止めて記録する（parent の役割は止めない）
  private async enqueueSource(state: RepositoryState): Promise<void> {
    const source = snapshotOf(state);
    if (!source) {
      this.logger.log("warn", {
        event: "source_skipped",
        source: state.repository.fullName,
        reason: "default branch not found",
      });

      return;
    }

    let targets: Target[];

    try {
      targets = targetsOf(state.configs);
    } catch (error) {
      if (!isPermanent(error)) throw error;

      this.logger.log("error", {
        event: "sync_failed",
        source: source.fullName,
        kind: error.kind,
        errorMessage: error.message,
      });

      return;
    }

    const { targets: previousTargets, skipped } = readPreviousTargets(state.previous);
    // 設定ファイルがある repo だけ、cleanup を見送った理由を記録する（設定のない repo は source ではないので記録しない）
    if (skipped && state.configs.length > 0) {
      this.logger.log("warn", { event: "cleanup_skipped", source: source.fullName, reason: skipped });
    }

    // target がなく、削除差分もない repo（設定がない、または dispatch の section がない）は source として扱わない
    if (targets.length === 0 && previousTargets.length === 0) {
      this.logger.log("info", { event: "source_skipped", source: source.fullName, reason: "no config" });

      return;
    }

    const removed = previousTargets.filter((previous) => !findTargetFor(targets, previous.repository));
    await this.enqueue([
      ...targets.map((target) => ({
        event: "sync-target" as const,
        source: source.fullName,
        target: target.repository,
      })),
      ...removed.map((target) => ({
        event: "close-target" as const,
        source: source.fullName,
        target: target.repository,
      })),
    ]);
  }

  // parent の役割: base が baseBranch の Open PR を持つ管理 branch ごとに、その source の同期の子 message を積む（省略すれば全部）
  // 管理 branch 名から source を戻せないものは、触らずに記録する
  private async enqueueParent(state: RepositoryState, baseBranch?: string): Promise<void> {
    const parent = state.repository.fullName;
    if (state.managed === "overflow") {
      this.logger.log("error", {
        event: "sync_failed",
        parent,
        kind: "undeterminable",
        errorMessage: "too many managed branches",
      });

      return;
    }

    const messages: ChildMessage[] = [];
    for (const managed of state.managed) {
      if (baseBranch !== undefined && !managed.baseBranches.includes(baseBranch)) continue;
      const source = sourceOf(managed.head);
      if (!source) {
        this.logger.log("warn", {
          event: "head_skipped",
          parent,
          head: managed.head,
          reason: "not a managed branch name",
        });

        continue;
      }

      messages.push({ event: "sync-target", source, target: parent });
    }

    await this.enqueue(messages);
  }

  // 1 回分の同期
  // configPath は target を読んだ設定ファイルの path
  private async attemptSync(source: SourceSnapshot, target: Target, configPath: string): Promise<AttemptResult> {
    const head = managedBranchName(source.fullName);
    const state = await this.gateway.readParentState(target.repository, {
      baseBranch: target.baseBranch,
      head,
      path: target.path,
    });
    const parent = state.repository.fullName;
    const base = baseOf(state, target, source);
    const isUnchanged = () => this.unchanged(source, parent, base.branch, base.sha);

    const plan = planPullRequests(state.pullRequests, base.branch);
    // base の変更で GitHub の同一 head/base 制約に当たらないよう、重複 PR を先に閉じる
    await this.autoclose(parent, plan.duplicates);

    // 祖先関係は見ず、source の最新 HEAD と一致するかだけで要否を決める
    if (base.previousSha === source.sha) {
      if (!plan.keep) return "unchanged";

      // 古い S で P == S と判断して Close しないよう、直前に確かめる
      if (!(await isUnchanged())) return "retry";
      await this.autoclose(parent, [plan.keep]);

      return "autoclosed";
    }

    // 最後に Close された PR が Dispatch の Close した PR なら、新しい PR を作らずに Open へ戻して使う
    // merge した PR の後に、autoclosed の PR が並ばないようにするため
    const latest = state.lastClosedPullRequest;
    if (!plan.keep && latest && !latest.merged && isAutoclosed(latest.title)) {
      // 古い S で Open に戻し、すぐ Close し直すことにならないよう、直前に確かめる
      if (!(await isUnchanged())) return "retry";
      if ((await this.reopen(source, parent, { head, sha: state.branch?.sha }, latest)) === "retry") return "retry";
    }

    const pullRequest = plan.keep;
    const baseChanged = pullRequest !== undefined && pullRequest.baseBranch !== base.branch;
    if (pullRequest && baseChanged) {
      await this.gateway.updatePullRequest(parent, pullRequest.number, { baseBranch: base.branch });
    }

    const title = updateTitle(source.fullName);
    let committed = false;
    if (!isUpToDate({ baseSha: base.sha, sourceSha: source.sha, expectedMessage: title, branchCommit: state.branch })) {
      const treeSha = await this.gateway.createGitlinkTree(parent, {
        baseTreeSha: base.treeSha,
        path: target.path,
        gitlinkSha: source.sha,
      });

      // 別の run が新しい S で更新した後に、古い S で上書きしないよう確かめる
      if (!(await isUnchanged())) return "retry";
      const commitSha = await this.gateway.createCommit(parent, { treeSha, parentSha: base.sha, message: title });

      // CAS が目的で、手動 commit は保護しない
      // 競合したら取得し直して上書きする
      if (
        (await this.gateway.updateRef(parent, head, { before: state.branch?.sha, after: commitSha })) === "conflict"
      ) {
        return "retry";
      }

      committed = true;
    }

    // 本文は毎回、source と base の現在の状態から作る
    const included = await this.includedCommits(source, parent, base.previousSha);
    const body = pullRequestBody({
      source: source.fullName,
      sourceBranch: source.defaultBranch,
      sourceSha: source.sha,
      path: target.path,
      baseBranch: base.branch,
      previousSha: base.previousSha,
      configPath,
      included: included === "failed" ? undefined : included,
    });

    // branch が正しくても PR がなければ作る（残った branch や、PR の作成だけが失敗した後）
    // 作成が 422 などで失敗しても、再実行で状態を読み直せば、作成済みの PR を見つけられる
    if (!pullRequest) {
      await this.gateway.createPullRequest(parent, { head, base: base.branch, title, body });
    } else {
      // 既存の PR の本文は、作った本文と違うときだけ書き換える（前回の書き換えが失敗した後や、手で編集された後も揃う）
      // commit の一覧を取得できず、既存の本文の一覧以外が今の状態と同じなら、一覧のある既存の本文を残す
      // 手で Open に戻された PR に残った suffix も外し、後で手動の Close を Dispatch の Close と取り違えないようにする
      const keepBody = included === "failed" && withoutCommitList(pullRequest.body) === body;

      const patch: { body?: string; title?: string } = {};
      if (!keepBody && pullRequest.body !== body) patch.body = body;
      if (isAutoclosed(pullRequest.title)) patch.title = title;

      if (patch.body !== undefined || patch.title !== undefined) {
        await this.gateway.updatePullRequest(parent, pullRequest.number, patch);
      }
    }

    const outcome: SyncOutcome = !pullRequest ? "created" : committed || baseChanged ? "updated" : "unchanged";
    if (outcome === "unchanged") return outcome;

    // 確認直後以降の base の進行は次の push で追従する
    if ((await this.gateway.getBranchHead(parent, base.branch)) !== base.sha) return "retry";

    return outcome;
  }

  // 書き込みの直前に、source の default branch（名前と HEAD）と parent の base の HEAD が、読んだときのままか確かめる
  // default branch が変わった場合や、別の run が先に更新した場合に、古い状態で上書きや Close をしないため
  private unchanged(source: SourceSnapshot, parent: string, baseBranch: string, baseSha: string) {
    return this.gateway.checkUnchanged({
      source: { repository: source.fullName, defaultBranch: source.defaultBranch, sha: source.sha },
      parent: { repository: parent, branch: baseBranch, sha: baseSha },
    });
  }

  // Dispatch が Close した PR を Open に戻す
  // GitHub は Close 中に head が force push された PR を Open に戻せないため、先に head を Close したときの commit へ戻す
  // Open に戻せたら、その PR を既存の PR として更新するため retry を返す
  // 戻せなければ新しい PR を作るため continue を返す（head を戻した後なら、戻した branch を読み直すため retry）
  // branchSha は管理 branch の今の HEAD（branch がなければ undefined）
  private async reopen(
    source: SourceSnapshot,
    parent: string,
    branch: { head: string; sha: string | undefined },
    pullRequest: ClosedPullRequest
  ): Promise<"retry" | "continue"> {
    const restore = branch.sha !== pullRequest.headSha;

    if (
      restore &&
      (await this.gateway.updateRef(parent, branch.head, { before: branch.sha, after: pullRequest.headSha })) ===
        "conflict"
    ) {
      return "retry";
    }

    const log = { source: source.fullName, parent, number: pullRequest.number };
    if (await this.gateway.reopenPullRequest(parent, pullRequest.number, updateTitle(source.fullName))) {
      this.logger.log("info", { event: "pull_request_reopened", ...log });

      return "retry";
    }

    this.logger.log("warn", { event: "reopen_failed", ...log });

    return restore ? "retry" : "continue";
  }

  // commit の一覧は補足なので、取得に失敗しても一覧なしで同期を続ける
  // 失敗したら undefined の代わりに failed を返し、呼び出し側が既存の本文を残すか決める
  private includedCommits(source: SourceSnapshot, parent: string, previousSha: string) {
    return this.gateway.compareCommits(source.fullName, previousSha, source.sha).catch((error: unknown) => {
      this.logger.log("warn", {
        event: "compare_failed",
        source: source.fullName,
        parent,
        errorMessage: error instanceof Error ? error.message : "unknown error",
      });

      return "failed" as const;
    });
  }

  private async autoclose(parent: string, pullRequests: OpenPullRequest[]): Promise<void> {
    for (const pr of pullRequests) {
      await this.gateway.updatePullRequest(parent, pr.number, {
        title: withAutoclosedSuffix(pr.title),
        closed: true,
      });
    }
  }
}
