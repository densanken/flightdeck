import { validatePullRequestTitle } from "@flightdeck/pr-title";

import { reconcileTitleValidationComments } from "./comment-reconciler.js";
import { TitleValidationExecutionError } from "./errors.js";
import { HeadStatusTracker } from "./head-status-tracker.js";
import {
  allTitlesValid,
  commentBody,
  currentHeadVerdict,
  headVerdict,
  normalizeAssociatedPullRequests,
  sameDetachedHeadState,
  samePolicyState,
} from "./policy-state.js";
import { SupersededStatusSweep } from "./superseded-status-sweep.js";
import { TITLE_STATUS_MESSAGES } from "../../domain/title-status-message.js";
import { ConfigurationError, PullRequestStateChangedError } from "../../errors.js";

import type { TitleStatusState, TitleValidationGateway, TitleValidationPhases } from "./dependencies.js";
import type {
  TitleValidationOutcome,
  ValidatePullRequestTitleCommand,
  ValidatePullRequestTitleUseCase,
} from "./interface.js";
import type { DetachedHeadPolicyState, PullRequestPolicyState } from "./policy-state.js";
import type { TitleStatusMessage } from "../../domain/title-status-message.js";

const { supersededHead: SUPERSEDED_HEAD_MESSAGE, failClosed: FAIL_CLOSED_MESSAGE } = TITLE_STATUS_MESSAGES;
// 古い delivery による status の上書きを検出しつつ API 往復を制限する
const MAX_STATUS_STABILIZATION_ATTEMPTS = 2;

interface TitleValidationExecutionContext {
  heads: HeadStatusTracker;
  currentStateLoaded: boolean;
}

const pullRequestCoordinates = (command: ValidatePullRequestTitleCommand) => ({
  owner: command.owner,
  repo: command.repo,
  pullRequestNumber: command.pullRequestNumber,
});

const headCoordinates = (command: ValidatePullRequestTitleCommand, headSha: string) => ({
  owner: command.owner,
  repo: command.repo,
  headShas: [headSha],
});

export class ValidatePullRequestTitleUseCaseImpl implements ValidatePullRequestTitleUseCase {
  constructor(
    private readonly gateway: TitleValidationGateway,
    private readonly getConfiguredAppBotUserId: () => number,
    private readonly phaseGateways: TitleValidationPhases
  ) {}

  private forGateway(gateway: TitleValidationGateway): ValidatePullRequestTitleUseCaseImpl {
    return new ValidatePullRequestTitleUseCaseImpl(gateway, this.getConfiguredAppBotUserId, this.phaseGateways);
  }

  private sweep(context: TitleValidationExecutionContext): SupersededStatusSweep {
    return new SupersededStatusSweep(
      this.phaseGateways,
      (command, sha, state, message, signal) =>
        this.postStatus(command, sha, state, message, signal, context, this.phaseGateways.sweep, false),
      context.heads,
      (command, signal, shas) =>
        this.forGateway(this.phaseGateways.recoveryStatus).bestEffortFailClosedStatuses(command, context, signal, {
          retryCurrent: false,
          only: shas,
        })
    );
  }

  async execute(
    command: ValidatePullRequestTitleCommand,
    signal: AbortSignal,
    hardDeadlineSignal: AbortSignal = signal
  ): Promise<TitleValidationOutcome> {
    // 通常処理の deadline 後も hard deadline までの残り時間があれば、既知の SHA を再収束または fail-closed にできる
    const context: TitleValidationExecutionContext = {
      heads: new HeadStatusTracker(command.fallbackHeadSha, command.previousHeadSha),
      currentStateLoaded: false,
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
        return await this.finish(
          command,
          confirmedState,
          initialReconciliation.outcome,
          context,
          signal,
          hardDeadlineSignal
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
        return await this.finish(
          command,
          finalState,
          latestReconciliation.outcome,
          context,
          signal,
          hardDeadlineSignal
        );
      }
      await this.forGateway(this.phaseGateways.recovery).reconcileDepartedHead(
        command,
        latestReconciliation.state,
        finalState,
        hardDeadlineSignal,
        context
      );
      return await this.forGateway(this.phaseGateways.recoveryStatus).failClosedForStateChange(
        command,
        finalState.current.headSha,
        hardDeadlineSignal,
        context
      );
    } catch (error) {
      context.heads.beginRecovery();
      if (
        !context.currentStateLoaded ||
        (error instanceof TitleValidationExecutionError && error.stage === "identity_validation_failed")
      ) {
        await this.forGateway(this.phaseGateways.recoveryStatus).bestEffortFailClosedStatuses(
          command,
          context,
          hardDeadlineSignal
        );
      } else {
        await this.forGateway(this.phaseGateways.recovery).bestEffortReconcileKnownHeadStatuses(
          command,
          context,
          hardDeadlineSignal,
          this.phaseGateways.recoveryStatus
        );
      }
      throw error;
    }
  }

  private async finish(
    command: ValidatePullRequestTitleCommand,
    state: PullRequestPolicyState,
    outcome: TitleValidationOutcome,
    context: TitleValidationExecutionContext,
    signal: AbortSignal,
    hardDeadlineSignal: AbortSignal
  ): Promise<TitleValidationOutcome> {
    if (state.current.state !== "open") return outcome;
    return await this.sweep(context).run(command, state.current.headSha, outcome, signal, hardDeadlineSignal);
  }

  private async loadCurrentPolicyState(
    command: ValidatePullRequestTitleCommand,
    signal: AbortSignal,
    context: TitleValidationExecutionContext
  ): Promise<PullRequestPolicyState> {
    try {
      const requestedHead = context.heads.current;
      const { current, associatedPullRequests: fetched } = await this.gateway.getCurrentPolicyState(
        { ...pullRequestCoordinates(command), headSha: requestedHead },
        signal
      );
      context.heads.setCurrent(current.headSha);
      context.currentStateLoaded = true;

      const associatedPullRequests = normalizeAssociatedPullRequests(
        (requestedHead === current.headSha ? fetched : undefined) ??
          (await this.gateway.listOpenPullRequestsForHeadShas(headCoordinates(command, current.headSha), signal)),
        current.headSha,
        { number: command.pullRequestNumber, state: current }
      );

      return {
        current,
        associatedPullRequests,
        currentValidation: validatePullRequestTitle(current.title),
        allTitlesValid: allTitlesValid(associatedPullRequests),
      };
    } catch (error) {
      throw new TitleValidationExecutionError("state_lookup_failed", error);
    }
  }

  private async loadDetachedHeadPolicyState(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    signal: AbortSignal,
    context: TitleValidationExecutionContext,
    recovery = false
  ): Promise<DetachedHeadPolicyState> {
    try {
      context.heads.remember(headSha);
      const fetched = await this.gateway.getCurrentPolicyState({ ...pullRequestCoordinates(command), headSha }, signal);
      const current = recovery ? fetched.current : undefined;
      if (current && current.headSha !== context.heads.current) context.heads.setCurrent(current.headSha);
      const associatedPullRequests = normalizeAssociatedPullRequests(
        fetched.associatedPullRequests ??
          (await this.gateway.listOpenPullRequestsForHeadShas(headCoordinates(command, headSha), signal)),
        headSha,
        current ? { number: command.pullRequestNumber, state: current } : undefined
      );
      return { headSha, associatedPullRequests, current };
    } catch (error) {
      throw new TitleValidationExecutionError("state_lookup_failed", error);
    }
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
    const commentOutcome = await reconcileTitleValidationComments(
      this.gateway,
      pullRequestCoordinates(command),
      commentBody(state),
      configuredAppBotUserId,
      signal
    );
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
      if (context.heads.isProtected(state.current.headSha)) {
        throw new TitleValidationExecutionError("state_changed", new PullRequestStateChangedError());
      }
      await this.postCurrentStatus(command, state, signal, context);
      const confirmedState = await this.loadCurrentPolicyState(command, signal, context);
      if (samePolicyState(state, confirmedState)) {
        context.heads.confirm(state.current.headSha);
        return state;
      }
      await this.reconcileDepartedHead(command, state, confirmedState, signal, context);
      state = confirmedState;
    }

    return this.failClosedForStateChange(command, state.current.headSha, signal, context);
  }

  private async stabilizeDetachedHeadStatus(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    signal: AbortSignal,
    context: TitleValidationExecutionContext,
    recovery = false,
    initialState?: DetachedHeadPolicyState
  ): Promise<void> {
    const currentHead = context.heads.current;
    let state = initialState ?? (await this.loadDetachedHeadPolicyState(command, headSha, signal, context, recovery));
    if (recovery && context.heads.current !== currentHead) return;

    for (let attempt = 0; attempt < MAX_STATUS_STABILIZATION_ATTEMPTS; attempt += 1) {
      // この SHA を head に持つ open PR が残っていなければ、最新 commit ではないので gate を開ける
      const verdict =
        state.associatedPullRequests.length === 0
          ? { state: "success" as const, message: SUPERSEDED_HEAD_MESSAGE }
          : headVerdict({ associatedPullRequests: state.associatedPullRequests });
      await this.postStatus(command, state.headSha, verdict.state, verdict.message, signal, context);
      const confirmedState = await this.loadDetachedHeadPolicyState(command, headSha, signal, context, recovery);
      if (recovery && context.heads.current !== currentHead) return;
      if (sameDetachedHeadState(state, confirmedState)) {
        context.heads.confirm(headSha);
        return;
      }
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

  private async postStatus(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    state: TitleStatusState,
    message: TitleStatusMessage,
    signal: AbortSignal,
    context: TitleValidationExecutionContext,
    gateway: Pick<TitleValidationGateway, "setTitleStatus"> = this.gateway,
    retry?: boolean
  ): Promise<void> {
    context.heads.register(headSha);
    try {
      await gateway.setTitleStatus(
        { owner: command.owner, repo: command.repo, sha: headSha, state, ...message, retry },
        signal
      );
      if (state === "error") context.heads.protect(headSha);
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
    context.heads.protect(headSha);
    throw new TitleValidationExecutionError("state_changed", new PullRequestStateChangedError());
  }

  private async bestEffortFailClosedStatuses(
    command: ValidatePullRequestTitleCommand,
    context: TitleValidationExecutionContext,
    signal: AbortSignal,
    { retryCurrent = true, only }: { retryCurrent?: boolean; only?: ReadonlySet<string> } = {}
  ): Promise<void> {
    const visited = new Set<string>();
    let headSha: string | undefined;
    while ((headSha = context.heads.next(visited)) !== undefined) {
      visited.add(headSha);
      if (only && !only.has(headSha)) continue;
      try {
        await this.gateway.setTitleStatus(
          {
            owner: command.owner,
            repo: command.repo,
            sha: headSha,
            state: "error",
            ...FAIL_CLOSED_MESSAGE,
            retry: retryCurrent && headSha === context.heads.current,
          },
          signal
        );
        context.heads.protect(headSha);
      } catch {
        context.heads.failProtection(headSha);
        this.phaseGateways.log("title_status_protection_failed", 1, headSha);
      }
    }
  }

  /**
   * 通常処理が失敗しても、別の open PR が共有する SHA を無条件の error で塞がない
   * 現在の集約状態を再取得できた SHA はその verdict へ収束させ、再取得も失敗した SHA だけを fail-closed にする
   */
  private async bestEffortReconcileKnownHeadStatuses(
    command: ValidatePullRequestTitleCommand,
    context: TitleValidationExecutionContext,
    signal: AbortSignal,
    recoveryStatus: TitleValidationGateway
  ): Promise<void> {
    const visited = new Set<string>();
    let initialState: DetachedHeadPolicyState | undefined;
    const initialHead = context.heads.current;
    try {
      initialState = await this.loadDetachedHeadPolicyState(command, initialHead, signal, context, true);
    } catch {
      visited.add(initialHead);
    }

    let headSha: string | undefined;
    while ((headSha = context.heads.next(visited)) !== undefined) {
      visited.add(headSha);
      try {
        await this.stabilizeDetachedHeadStatus(
          command,
          headSha,
          signal,
          context,
          true,
          initialState?.headSha === headSha ? initialState : undefined
        );
      } catch {
        // 再収束できなかった head は後で fail-closed にする
      }
    }
    await this.forGateway(recoveryStatus).bestEffortFailClosedStatuses(command, context, signal, {
      retryCurrent: false,
    });
  }
}
