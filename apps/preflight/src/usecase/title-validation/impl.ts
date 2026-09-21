import { hasDraftTitleMarker, validatePullRequestTitle } from "@flightdeck/pr-title";

import { reconcileTitleValidationComments } from "./comment-reconciler.js";
import { TitleValidationExecutionError } from "./errors.js";
import {
  buildDraftMarkerTitleComment,
  buildDraftTitleComment,
  buildTitleValidationFailureComment,
} from "../../domain/title-comment.js";
import { buildTitleFailureStatusMessage, TITLE_STATUS_MESSAGES } from "../../domain/title-status-message.js";
import { ConfigurationError, PullRequestStateChangedError } from "../../errors.js";

import type {
  AssociatedPullRequestTitle,
  PullRequestCommitTitleStatus,
  PullRequestTitleState,
  TitleStatusState,
  TitleValidationGateway,
} from "./dependencies.js";
import type {
  TitleValidationOutcome,
  ValidatePullRequestTitleCommand,
  ValidatePullRequestTitleUseCase,
} from "./interface.js";
import type { TitleStatusMessage } from "../../domain/title-status-message.js";
import type { TitleValidationResult } from "@flightdeck/pr-title";

const {
  success: SUCCESS_MESSAGE,
  draft: DRAFT_MESSAGE,
  wipTitle: WIP_TITLE_MESSAGE,
  emptyHead: EMPTY_HEAD_MESSAGE,
  supersededHead: SUPERSEDED_HEAD_MESSAGE,
  failClosed: FAIL_CLOSED_MESSAGE,
} = TITLE_STATUS_MESSAGES;
// 古い delivery による status の上書きを検出しつつ API 往復を制限する
const MAX_STATUS_STABILIZATION_ATTEMPTS = 2;
// 1 delivery あたりの掃除書き込み上限
// 取り残しは次の delivery が同じ走査で拾う
const MAX_SUPERSEDED_WRITES_PER_DELIVERY = 20;

interface TitleValidationExecutionContext {
  currentFailClosedHeadSha: string;
  additionalFailClosedHeadShas: Set<string>;
  currentStateLoaded: boolean;
  /**
   * 1 delivery 内で同じ head SHA の open PR 一覧を読み直さないための memo
   * postStatus による status の書き込みは該当 head SHA だけを、
   * コメント同期は head SHA 自体が別の memo 済み SHA へ変わりうるため全 entry を、
   * 書き込みや同期の成否に関わらず都度 invalidate し、write-then-reread の drift 検出を壊さない
   */
  associatedPullRequestsCache: Map<string, AssociatedPullRequestTitle[]>;
}

interface PullRequestPolicyState {
  current: PullRequestTitleState;
  associatedPullRequests: AssociatedPullRequestTitle[];
  currentValidation: TitleValidationResult;
  allTitlesValid: boolean;
}

interface DetachedHeadPolicyState {
  headSha: string;
  associatedPullRequests: AssociatedPullRequestTitle[];
}

// draft は verdict を決める入力なので、比較から外すと draft の切り替えを「変化なし」と見て古い verdict のまま止まる
const samePullRequestState = (left: PullRequestTitleState, right: PullRequestTitleState): boolean =>
  left.title === right.title &&
  left.headSha === right.headSha &&
  left.state === right.state &&
  left.draft === right.draft;

const sameAssociatedPullRequests = (left: AssociatedPullRequestTitle[], right: AssociatedPullRequestTitle[]): boolean =>
  left.length === right.length &&
  left.every((pullRequest, index) => {
    const candidate = right.at(index);
    return (
      pullRequest.number === candidate?.number &&
      pullRequest.title === candidate.title &&
      pullRequest.headSha === candidate.headSha &&
      pullRequest.draft === candidate.draft
    );
  });

const samePolicyState = (left: PullRequestPolicyState, right: PullRequestPolicyState): boolean =>
  samePullRequestState(left.current, right.current) &&
  sameAssociatedPullRequests(left.associatedPullRequests, right.associatedPullRequests);

const sameDetachedHeadState = (left: DetachedHeadPolicyState, right: DetachedHeadPolicyState): boolean =>
  left.headSha === right.headSha &&
  sameAssociatedPullRequests(left.associatedPullRequests, right.associatedPullRequests);

const pullRequestCoordinates = (command: ValidatePullRequestTitleCommand) => ({
  owner: command.owner,
  repo: command.repo,
  pullRequestNumber: command.pullRequestNumber,
});

const headCoordinates = (command: ValidatePullRequestTitleCommand, headSha: string) => ({
  owner: command.owner,
  repo: command.repo,
  headSha,
});

const normalizeAssociatedPullRequests = (
  associatedPullRequests: AssociatedPullRequestTitle[],
  headSha: string
): AssociatedPullRequestTitle[] => {
  const byNumber = new Map<number, AssociatedPullRequestTitle>();
  for (const pullRequest of associatedPullRequests) {
    if (pullRequest.headSha !== headSha || byNumber.has(pullRequest.number)) {
      throw new Error("Invalid associated pull request state");
    }
    byNumber.set(pullRequest.number, pullRequest);
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
};

/**
 * head から外れ、かつ success 以外の status が残っている commit
 * まだ open PR の head である commit は、その PR の判定になるため対象外にする
 * 関連 PR が多くて head かどうかを確定できない commit も、安全側に倒して対象外にする
 */
const supersededShas = (commits: PullRequestCommitTitleStatus[], headSha: string): string[] =>
  commits
    .filter(
      (commit) =>
        commit.sha !== headSha &&
        commit.statusState === "not_success" &&
        !commit.isOpenPullRequestHead &&
        !commit.associatedPullRequestsTruncated
    )
    .map((commit) => commit.sha);

/**
 * gate の判定に加える PR
 * draft PR は GitHub 自身が merge を拒むので外せるが、作業中の接頭辞が付いた PR はそのまま merge できてしまう
 * 接頭辞付きの PR を外すと、同じ commit を head に持つ別の PR が green にした瞬間に接頭辞付きのまま merge できるため、
 * 接頭辞付きの PR は gate に残したまま pending で止める
 */
const gatingPullRequests = (pullRequests: AssociatedPullRequestTitle[]): AssociatedPullRequestTitle[] =>
  pullRequests.filter((pullRequest) => !pullRequest.draft);

const allTitlesValid = (pullRequests: AssociatedPullRequestTitle[]): boolean => {
  const gating = gatingPullRequests(pullRequests);
  return gating.length > 0 && gating.every((pullRequest) => validatePullRequestTitle(pullRequest.title).valid);
};

// 接頭辞付きのタイトルは常に validatePullRequestTitle でも無効になるため、無効判定から明示的に除いて保留側へ振り分ける
const isInvalidGatingTitle = (title: string): boolean =>
  !hasDraftTitleMarker(title) && !validatePullRequestTitle(title).valid;

/**
 * commit status に出す state と文言を決める
 * 修正が要る失敗を最優先で出し、次に作業中を示す保留、最後に成功という順で見る
 * 接頭辞付きのタイトルは修正待ちではなく作業中なので、failure ではなく pending にする
 */
const headVerdict = (input: {
  associatedPullRequests: AssociatedPullRequestTitle[];
}): { state: TitleStatusState; message: TitleStatusMessage } => {
  if (input.associatedPullRequests.length === 0) return { state: "success", message: EMPTY_HEAD_MESSAGE };
  const gating = gatingPullRequests(input.associatedPullRequests);
  // この commit を head に持つ open PR がすべて draft なら、まだ判定しない
  if (gating.length === 0) return { state: "pending", message: DRAFT_MESSAGE };

  const invalid = gating.filter((pullRequest) => isInvalidGatingTitle(pullRequest.title));
  const [firstInvalid, ...remainingInvalid] = invalid;
  if (firstInvalid) {
    return {
      state: "failure",
      message: buildTitleFailureStatusMessage([
        firstInvalid.number,
        ...remainingInvalid.map((pullRequest) => pullRequest.number),
      ]),
    };
  }

  const wip = gating.filter((pullRequest) => hasDraftTitleMarker(pullRequest.title));
  if (wip.length > 0) return { state: "pending", message: WIP_TITLE_MESSAGE };
  return { state: "success", message: SUCCESS_MESSAGE };
};

/**
 * 処理対象 PR に出すコメント本文
 * 不要なら null
 */
const commentBody = (state: PullRequestPolicyState): string | null => {
  if (state.current.state !== "open") return null;
  if (state.current.draft && !state.currentValidation.valid) return buildDraftTitleComment(state.currentValidation);
  if (hasDraftTitleMarker(state.current.title)) return buildDraftMarkerTitleComment(state.current.title);
  if (!state.currentValidation.valid) return buildTitleValidationFailureComment(state.currentValidation);
  return null;
};

const currentHeadVerdict = (state: PullRequestPolicyState): { state: TitleStatusState; message: TitleStatusMessage } =>
  headVerdict({ associatedPullRequests: state.associatedPullRequests });

export class ValidatePullRequestTitleUseCaseImpl implements ValidatePullRequestTitleUseCase {
  constructor(
    private readonly gateway: TitleValidationGateway,
    private readonly getConfiguredAppBotUserId: () => number
  ) {}

  async execute(
    command: ValidatePullRequestTitleCommand,
    signal: AbortSignal,
    hardDeadlineSignal: AbortSignal = signal
  ): Promise<TitleValidationOutcome> {
    // 通常処理の deadline 後も hard deadline までの残り時間があれば、既知の SHA を再収束または fail-closed にできる
    const context: TitleValidationExecutionContext = {
      currentFailClosedHeadSha: command.fallbackHeadSha,
      additionalFailClosedHeadShas: new Set(
        [command.fallbackHeadSha, command.previousHeadSha].filter((headSha): headSha is string => headSha !== undefined)
      ),
      currentStateLoaded: false,
      associatedPullRequestsCache: new Map(),
    };
    try {
      const initialState = await this.loadCurrentPolicyState(command, signal, context);
      const configuredAppBotUserId = await this.verifyAppBotUserId(signal);
      const detachedHeadShas = new Set(
        [command.fallbackHeadSha, command.previousHeadSha].filter((headSha): headSha is string => headSha !== undefined)
      );
      detachedHeadShas.delete(initialState.current.headSha);
      for (const headSha of detachedHeadShas) {
        await this.stabilizeDetachedHeadStatus(command, headSha, signal, context);
      }

      const initialReconciliation = await this.reconcileStableState(
        command,
        initialState,
        configuredAppBotUserId,
        signal,
        context
      );
      const confirmedState = await this.loadCurrentPolicyState(command, signal, context);
      if (samePolicyState(initialReconciliation.state, confirmedState)) {
        return await this.withSupersededSweep(
          command,
          confirmedState.current.headSha,
          initialReconciliation.outcome,
          signal,
          context
        );
      }
      await this.reconcileDepartedHead(command, initialReconciliation.state, confirmedState, signal, context);

      const latestReconciliation = await this.reconcileStableState(
        command,
        confirmedState,
        configuredAppBotUserId,
        signal,
        context
      );
      const finalState = await this.loadCurrentPolicyState(command, signal, context);
      if (samePolicyState(latestReconciliation.state, finalState)) {
        return await this.withSupersededSweep(
          command,
          finalState.current.headSha,
          latestReconciliation.outcome,
          signal,
          context
        );
      }
      await this.reconcileDepartedHead(command, latestReconciliation.state, finalState, hardDeadlineSignal, context);
      return await this.failClosedForStateChange(command, finalState.current.headSha, hardDeadlineSignal, context);
    } catch (error) {
      if (!(error instanceof TitleValidationExecutionError && error.stage === "state_changed")) {
        if (
          !context.currentStateLoaded ||
          (error instanceof TitleValidationExecutionError && error.stage === "identity_validation_failed")
        ) {
          await this.bestEffortFailClosedStatuses(command, context, hardDeadlineSignal);
        } else {
          await this.bestEffortReconcileKnownHeadStatuses(command, context, hardDeadlineSignal);
        }
      }
      throw error;
    }
  }

  private async loadCurrentPolicyState(
    command: ValidatePullRequestTitleCommand,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<PullRequestPolicyState> {
    try {
      const current = await this.gateway.getCurrentPullRequestTitleState(pullRequestCoordinates(command), signal);
      context.currentFailClosedHeadSha = current.headSha;
      context.currentStateLoaded = true;
      const associatedPullRequests = normalizeAssociatedPullRequests(
        await this.listAssociatedPullRequests(command, current.headSha, signal, context),
        current.headSha
      );
      const byNumber = new Map(associatedPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
      if (current.state === "open") {
        // opened 直後の一覧反映遅延でも現在の open PR を必ず集約対象へ含める
        byNumber.set(command.pullRequestNumber, {
          number: command.pullRequestNumber,
          title: current.title,
          headSha: current.headSha,
          draft: current.draft,
        });
      } else {
        // closed 直後に一覧へ残る現在 PR は集約対象から除く
        byNumber.delete(command.pullRequestNumber);
      }
      const normalized = [...byNumber.values()].sort((left, right) => left.number - right.number);
      return {
        current,
        associatedPullRequests: normalized,
        currentValidation: validatePullRequestTitle(current.title),
        allTitlesValid: allTitlesValid(normalized),
      };
    } catch (error) {
      throw new TitleValidationExecutionError("state_lookup_failed", error);
    }
  }

  private async loadDetachedHeadPolicyState(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<DetachedHeadPolicyState> {
    try {
      context.additionalFailClosedHeadShas.add(headSha);
      const associatedPullRequests = normalizeAssociatedPullRequests(
        await this.listAssociatedPullRequests(command, headSha, signal, context),
        headSha
      );
      return { headSha, associatedPullRequests };
    } catch (error) {
      throw new TitleValidationExecutionError("state_lookup_failed", error);
    }
  }

  /**
   * 同じ head SHA の open PR 一覧を 1 delivery 内で使い回す
   * postStatus が書き込み時に該当 head SHA を invalidate するため、write-then-reread の再取得は必ず新しい読み取りになる
   */
  private async listAssociatedPullRequests(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<AssociatedPullRequestTitle[]> {
    const cached = context.associatedPullRequestsCache.get(headSha);
    if (cached) return cached;
    const associatedPullRequests = await this.gateway.listOpenPullRequestsForHeadSha(
      headCoordinates(command, headSha),
      signal
    );
    context.associatedPullRequestsCache.set(headSha, associatedPullRequests);
    return associatedPullRequests;
  }

  private async verifyAppBotUserId(signal: AbortSignal): Promise<number> {
    try {
      const configuredAppBotUserId = this.getConfiguredAppBotUserId();
      const actualAppBotUserId = await this.gateway.getAuthenticatedAppBotUserId(signal);
      if (actualAppBotUserId !== configuredAppBotUserId) {
        throw new ConfigurationError("GITHUB_APP_BOT_USER_ID", "invalid");
      }
      return configuredAppBotUserId;
    } catch (error) {
      throw new TitleValidationExecutionError("identity_validation_failed", error);
    }
  }

  private async reconcileStableState(
    command: ValidatePullRequestTitleCommand,
    initialState: PullRequestPolicyState,
    configuredAppBotUserId: number,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<{ state: PullRequestPolicyState; outcome: TitleValidationOutcome }> {
    const state = await this.stabilizeCurrentCheck(command, initialState, signal, context);
    let commentOutcome;
    try {
      commentOutcome = await reconcileTitleValidationComments(
        this.gateway,
        pullRequestCoordinates(command),
        commentBody(state),
        configuredAppBotUserId,
        signal
      );
    } finally {
      // コメント同期には往復時間がかかり、その間に head SHA 自体が fallback/previous SHA など
      // 既に memo 済みの別 SHA へ変わりうる
      // current の head SHA だけでなく全 entry を落として、
      // 失敗して例外で抜けた場合も含め、以降の再判定が古い memo を再利用しないようにする
      context.associatedPullRequestsCache.clear();
    }
    const outcome: TitleValidationOutcome = {
      ...commentOutcome,
      result:
        state.current.state === "closed"
          ? "closed"
          : // pending は draft か作業中の接頭辞による保留で、共有 head の失敗と混ぜると alert の意味が変わる
            currentHeadVerdict(state).state === "pending"
            ? "held"
            : !state.currentValidation.valid
              ? "invalid"
              : state.allTitlesValid
                ? "valid"
                : "blocked_shared_head",
      supersededStatusesCleared: 0,
      supersededSweepFailed: false,
    };
    return {
      state,
      outcome,
    };
  }

  private async stabilizeCurrentCheck(
    command: ValidatePullRequestTitleCommand,
    initialState: PullRequestPolicyState,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<PullRequestPolicyState> {
    let state = initialState;
    for (let attempt = 0; attempt < MAX_STATUS_STABILIZATION_ATTEMPTS; attempt += 1) {
      await this.postCurrentStatus(command, state, signal, context);
      const confirmedState = await this.loadCurrentPolicyState(command, signal, context);
      if (samePolicyState(state, confirmedState)) return state;
      await this.reconcileDepartedHead(command, state, confirmedState, signal, context);
      state = confirmedState;
    }

    return this.failClosedForStateChange(command, state.current.headSha, signal, context);
  }

  private async stabilizeDetachedHeadStatus(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<void> {
    let state = await this.loadDetachedHeadPolicyState(command, headSha, signal, context);
    for (let attempt = 0; attempt < MAX_STATUS_STABILIZATION_ATTEMPTS; attempt += 1) {
      // この SHA を head に持つ open PR が残っていなければ、最新 commit ではないので gate を開ける
      const verdict =
        state.associatedPullRequests.length === 0
          ? { state: "success" as const, message: SUPERSEDED_HEAD_MESSAGE }
          : headVerdict({ associatedPullRequests: state.associatedPullRequests });
      await this.postStatus(command, state.headSha, verdict.state, verdict.message, signal, context);
      const confirmedState = await this.loadDetachedHeadPolicyState(command, headSha, signal, context);
      if (sameDetachedHeadState(state, confirmedState)) return;
      state = confirmedState;
    }
    await this.failClosedForStateChange(command, headSha, signal, context);
  }

  private async reconcileDepartedHead(
    command: ValidatePullRequestTitleCommand,
    previousState: PullRequestPolicyState,
    currentState: PullRequestPolicyState,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<void> {
    if (previousState.current.headSha !== currentState.current.headSha) {
      await this.stabilizeDetachedHeadStatus(command, previousState.current.headSha, signal, context);
    }
  }

  private async postCurrentStatus(
    command: ValidatePullRequestTitleCommand,
    state: PullRequestPolicyState,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<void> {
    const verdict = currentHeadVerdict(state);
    await this.postStatus(command, state.current.headSha, verdict.state, verdict.message, signal, context);
  }

  /**
   * head から外れた commit に残る status を success へ戻す
   * 直前の head だけでなく PR の全 commit を見るため、配信が落ちて取り残された commit も回収できる
   * gate は head commit の status で決まるので、掃除の失敗では delivery を retry させない
   */
  private async withSupersededSweep(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    outcome: TitleValidationOutcome,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<TitleValidationOutcome> {
    let cleared = 0;
    try {
      const commits = await this.gateway.listPullRequestCommitTitleStatuses(pullRequestCoordinates(command), signal);
      // 1 delivery で書く件数を絞る
      // 残りは次の delivery が同じ走査で拾う
      const staleShas = supersededShas(commits, headSha).slice(0, MAX_SUPERSEDED_WRITES_PER_DELIVERY);
      if (staleShas.length === 0) return outcome;

      const written = await Promise.allSettled(
        staleShas.map((sha) =>
          this.gateway.setTitleStatus(
            {
              owner: command.owner,
              repo: command.repo,
              sha,
              state: "success",
              ...SUPERSEDED_HEAD_MESSAGE,
            },
            signal
          )
        )
      );
      cleared = written.filter((result) => result.status === "fulfilled").length;

      // 読み取りから書き込みの間に force-push などで head へ復帰した commit を検出して verdict を戻す
      // 他の書き込み経路と同じく、書いたあとに現状態を読み直して収束させる
      const confirmed = await this.gateway.listPullRequestCommitTitleStatuses(pullRequestCoordinates(command), signal);
      const revived = confirmed.filter((commit) => staleShas.includes(commit.sha) && commit.isOpenPullRequestHead);
      for (const commit of revived) {
        await this.stabilizeDetachedHeadStatus(command, commit.sha, signal, context);
      }

      return {
        ...outcome,
        supersededStatusesCleared: cleared,
        supersededSweepFailed: written.some((result) => result.status === "rejected"),
      };
    } catch {
      return { ...outcome, supersededStatusesCleared: cleared, supersededSweepFailed: true };
    }
  }

  private async postStatus(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    state: TitleStatusState,
    message: TitleStatusMessage,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<void> {
    // 応答だけ失われた成否不明な書き込みでも、直後の再取得を必ず新しい読み取りにするため、
    // 書き込みの成否に関わらずこの head SHA の memo を破棄する
    context.associatedPullRequestsCache.delete(headSha);
    try {
      await this.gateway.setTitleStatus(
        { owner: command.owner, repo: command.repo, sha: headSha, state, ...message },
        signal
      );
    } catch (error) {
      throw new TitleValidationExecutionError("status_failed", error);
    }
  }

  private async failClosedForStateChange(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<never> {
    await this.postStatus(command, headSha, "error", FAIL_CLOSED_MESSAGE, signal, context);
    throw new TitleValidationExecutionError("state_changed", new PullRequestStateChangedError());
  }

  private async bestEffortFailClosedStatuses(
    command: ValidatePullRequestTitleCommand,
    context: TitleValidationExecutionContext,
    signal: AbortSignal
  ): Promise<void> {
    const headShas = new Set([context.currentFailClosedHeadSha, ...context.additionalFailClosedHeadShas]);
    // hard deadline までに既知の SHA をすべて戻せるよう error status を並行して再試行する
    await Promise.allSettled(
      [...headShas].map((headSha) =>
        this.gateway.setTitleStatus(
          {
            owner: command.owner,
            repo: command.repo,
            sha: headSha,
            state: "error",
            ...FAIL_CLOSED_MESSAGE,
          },
          signal
        )
      )
    );
  }

  /**
   * 通常処理が失敗しても、別の open PR が共有する SHA を無条件の error で塞がない
   * 現在の集約状態を再取得できた SHA はその verdict へ収束させ、再取得も失敗した SHA だけを fail-closed にする
   */
  private async bestEffortReconcileKnownHeadStatuses(
    command: ValidatePullRequestTitleCommand,
    context: TitleValidationExecutionContext,
    signal: AbortSignal
  ): Promise<void> {
    const headShas = new Set([context.currentFailClosedHeadSha, ...context.additionalFailClosedHeadShas]);
    await Promise.allSettled(
      [...headShas].map(async (headSha) => {
        try {
          await this.stabilizeDetachedHeadStatus(command, headSha, signal, context);
        } catch {
          await this.gateway.setTitleStatus(
            {
              owner: command.owner,
              repo: command.repo,
              sha: headSha,
              state: "error",
              ...FAIL_CLOSED_MESSAGE,
            },
            signal
          );
        }
      })
    );
  }
}
