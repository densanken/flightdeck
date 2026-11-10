import { MAX_OPEN_PULL_REQUEST_PAGES } from "./dependencies.js";
import { headVerdict, normalizeAssociatedPullRequests, sameAssociatedPullRequests } from "./policy-state.js";
import { TITLE_STATUS_MESSAGES } from "../../domain/title-status-message.js";

import type { AssociatedPullRequestTitle, TitleStatusState, TitleValidationPhases } from "./dependencies.js";
import type { HeadStatusTracker } from "./head-status-tracker.js";
import type { TitleValidationOutcome, ValidatePullRequestTitleCommand } from "./interface.js";
import type { TitleStatusMessage } from "../../domain/title-status-message.js";

const { supersededHead: SUPERSEDED_HEAD_MESSAGE } = TITLE_STATUS_MESSAGES;
const CONFIRMATION_BUDGET = 1 + MAX_OPEN_PULL_REQUEST_PAGES;
// 事前確認、書き込み 1 件、書き込み後の確認、修復 1 件を確保する
const SWEEP_COMMIT_RESERVE = 1 + 1 + CONFIRMATION_BUDGET + 1;

export class SupersededStatusSweep {
  constructor(
    private readonly phases: TitleValidationPhases,
    private readonly postStatus: (
      command: ValidatePullRequestTitleCommand,
      sha: string,
      state: TitleStatusState,
      message: TitleStatusMessage,
      signal: AbortSignal
    ) => Promise<void>,
    private readonly heads: HeadStatusTracker,
    private readonly protectPending: (
      command: ValidatePullRequestTitleCommand,
      signal: AbortSignal,
      shas: ReadonlySet<string>
    ) => Promise<void>
  ) {}

  /** head から外れた commit に残る status を success へ戻す */
  async run(
    command: ValidatePullRequestTitleCommand,
    headSha: string,
    outcome: TitleValidationOutcome,
    signal: AbortSignal,
    hardDeadlineSignal: AbortSignal
  ): Promise<TitleValidationOutcome> {
    const { sweep, recovery, budget, log } = this.phases;
    const maxWrites = budget.remaining("recovery_status");
    let cleared = 0;
    let failure: unknown;
    const written: string[] = [];

    try {
      const commits = await sweep.listPullRequestCommitTitleStatuses(
        {
          owner: command.owner,
          repo: command.repo,
          pullRequestNumber: command.pullRequestNumber,
          maxPages: budget.remaining("sweep") - SWEEP_COMMIT_RESERVE,
        },
        signal
      );
      const knownHeads = new Set([headSha, command.fallbackHeadSha, command.previousHeadSha]);
      const possible = commits.filter((commit) => commit.statusState === "not_success" && !knownHeads.has(commit.sha));
      const candidates: string[] = [];
      let skipped = 0;
      const batchSize = maxWrites * 3;
      for (let offset = 0; offset < possible.length && candidates.length < maxWrites; offset += batchSize) {
        if (budget.remaining("sweep") < SWEEP_COMMIT_RESERVE) {
          log("superseded_sweep_budget_exhausted", possible.length - offset);
          break;
        }
        const batch = possible.slice(offset, offset + batchSize);
        const classifications = await sweep.confirmSweepCommits(
          { owner: command.owner, repo: command.repo, shas: batch.map((commit) => commit.sha) },
          signal
        );
        for (const commit of batch) {
          const classification = classifications.get(commit.sha);
          if (classification?.length === 0) candidates.push(commit.sha);
          if (classification === undefined) skipped += 1;
        }
      }
      if (skipped > 0) log("superseded_comparison_skipped", skipped);

      for (const sha of candidates) {
        // 書き込み後の確認、修復投稿、最終 error 投稿の枠を残す
        if (written.length >= maxWrites || budget.remaining("sweep") < SWEEP_COMMIT_RESERVE - 1 + written.length) {
          log("superseded_sweep_budget_exhausted", candidates.length - written.length);
          break;
        }
        written.push(sha);
        try {
          await this.postStatus(command, sha, "success", SUPERSEDED_HEAD_MESSAGE, signal);
          cleared += 1;
        } catch (error) {
          failure ??= error;
        }
      }

      if (written.length > 0) {
        const confirmations = await this.confirmSweptHeads(command, written, signal);
        const repaired = new Map<string, AssociatedPullRequestTitle[]>();
        for (const [sha, pullRequests] of confirmations) {
          try {
            if (pullRequests.length > 0) {
              const verdict = headVerdict({ associatedPullRequests: pullRequests });
              await this.postStatus(command, sha, verdict.state, verdict.message, signal);
              repaired.set(sha, pullRequests);
            } else {
              this.heads.confirm(sha);
            }
          } catch (error) {
            failure ??= error;
          }
        }

        if (repaired.size > 0) {
          const confirmed = await this.confirmSweptHeads(command, [...repaired.keys()], signal, recovery);
          for (const [sha, current] of confirmed) {
            const previous = repaired.get(sha);
            if (previous && sameAssociatedPullRequests(previous, current)) this.heads.confirm(sha);
          }
          if (written.some((sha) => this.heads.isPending(sha))) {
            failure ??= new Error("Sweep repair could not be confirmed");
          }
        }
      }
    } catch (error) {
      failure ??= error;
    }

    await this.protectPending(command, hardDeadlineSignal, new Set(written));

    return {
      ...outcome,
      supersededStatusesCleared: cleared,
      supersededSweepFailed: failure !== undefined,
      supersededSweepError: failure,
    };
  }

  private async confirmSweptHeads(
    command: ValidatePullRequestTitleCommand,
    shas: string[],
    signal: AbortSignal,
    gateway = this.phases.sweep
  ): Promise<Map<string, AssociatedPullRequestTitle[]>> {
    const confirmations = await gateway.confirmSweepCommits({ owner: command.owner, repo: command.repo, shas }, signal);
    const scan = shas.filter((sha) => confirmations.get(sha) === undefined);
    const scanned =
      scan.length > 0
        ? await gateway.listOpenPullRequestsForHeadShas(
            { owner: command.owner, repo: command.repo, headShas: scan },
            signal
          )
        : [];

    return new Map(
      shas.map((sha) => [
        sha,
        normalizeAssociatedPullRequests(confirmations.get(sha) ?? scanned.filter((pr) => pr.headSha === sha), sha),
      ])
    );
  }
}
