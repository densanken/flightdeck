import { errors } from "../../../domain/errors.js";
import { nowIso } from "../../../domain/time.js";
import { getPullRequestHeadRef } from "../../../usecase/pull-request-branch.js";
import { escapeDiscordMarkdownLinkText, inlineCode, safeEmbedLinkUrl } from "../../../util/discord-markdown.js";
import { withLogContext } from "../../../util/logger.js";
import { truncateText } from "../../../util/truncate.js";
import { MAX_EMBED_FIELD_VALUE_LENGTH, MAX_EMBED_TITLE_LENGTH } from "../constants.js";
import { editDeferredResponse, editDeferredWithError } from "../followup.js";
import {
  appendLinesWithinLimit,
  getJapaneseErrorMessage,
  logCommandError,
  getStringOption,
  parsePrNumber,
  FORK_WORKFLOW_CHANGED_GUIDE,
  FORK_WORKFLOW_SYNC_GUIDE,
} from "../helpers.js";
import { deferredEphemeral, EmbedColor } from "../interaction-response.js";
import { assertNotLoadingSentinel } from "../timeout-budget.js";

import type { FailedCheck, FailedStatus, MergeGateRequiredStatusCheck } from "../../../domain/merge-gate.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/v10";
import type { Context } from "hono";

// 安全な URL があるときだけ名前を詳細ページへのリンクにする
const linkedName = (name: string, url: string | null): string => {
  const safeUrl = url ? safeEmbedLinkUrl(url) : null;
  return safeUrl ? `[${inlineCode(name)}](${safeUrl})` : inlineCode(name);
};

export const handleStatus = (
  c: Context<Env>,
  interaction: APIChatInputApplicationCommandInteraction,
  deps: DiscordDependencies
): Response => {
  const repoId = getStringOption(interaction.data.options, "repo");
  const prNumberStr = getStringOption(interaction.data.options, "pr");

  c.executionCtx.waitUntil(
    // 後続処理の log を対象の repository と PR で絞り込めるようにする
    withLogContext({ repoId, prNumber: prNumberStr ? Number(prNumberStr) : undefined }, async () => {
      try {
        if (!repoId) throw errors.invalidRequest("repo が指定されていません。");
        if (!prNumberStr) throw errors.invalidRequest("pr が指定されていません。");

        // autocomplete が timeout したときの読み込み中候補は実値ではないため、案内へ振り分ける
        assertNotLoadingSentinel(repoId);
        assertNotLoadingSentinel(prNumberStr);

        const prNumber = parsePrNumber(prNumberStr);

        const result = await deps.statusUsecase.getStatus({
          repoId,
          prNumber,
        });

        const { gateResult, forkWorkflowDrift, pr, repo } = result;
        const forkWorkflowNotice = {
          none: undefined,
          base_changed: `fork の \`.github/workflows\` が base と異なるため、このままでは GitHub にマージを拒否される見込みです。${FORK_WORKFLOW_SYNC_GUIDE}${inlineCode("/merge")} を実行してください。`,
          pr_changed: `この PR は \`.github/workflows\` を変更しているため、GitHub App ではマージできない見込みです。${FORK_WORKFLOW_CHANGED_GUIDE}`,
        }[forkWorkflowDrift];

        const items: string[] = [];
        if (!gateResult.canMerge) {
          const details = gateResult.error.details as
            | {
                failedChecks?: FailedCheck[];
                failedStatuses?: FailedStatus[];
                requiredChecks?: (MergeGateRequiredStatusCheck & { reason: "missing" | "source_mismatch" })[];
              }
            | undefined;
          for (const check of details?.failedChecks ?? []) {
            items.push(`- ${check.status === "completed" ? "🚫" : "⏳"} ${linkedName(check.name, check.htmlUrl)}`);
          }
          for (const status of details?.failedStatuses ?? []) {
            items.push(`- ${status.state === "pending" ? "⏳" : "🚫"} ${linkedName(status.context, status.targetUrl)}`);
          }
          // 必須 check の未実行と報告元の不一致は、どちらもそのままではマージできないため 🚫 で出す
          for (const check of details?.requiredChecks ?? []) {
            items.push(
              `- 🚫 ${inlineCode(check.context)}（${check.reason === "missing" ? "未実行" : "報告元が異なる"}）`
            );
          }
        }

        const statusValue = appendLinesWithinLimit(
          gateResult.canMerge ? "マージ条件をすべて満たしています。" : getJapaneseErrorMessage(gateResult.error),
          items,
          MAX_EMBED_FIELD_VALUE_LENGTH
        );

        // embed title も一部の markdown を解釈するため escape する
        // 上限を超える分は PR 番号を残して title 側を切り詰める
        const numberSuffix = ` (#${String(pr.number)})`;
        const maxTitleLength = MAX_EMBED_TITLE_LENGTH - numberSuffix.length;
        const prTitle = escapeDiscordMarkdownLinkText(pr.title);

        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, {
          title: `${truncateText(prTitle, maxTitleLength)}${numberSuffix}`,
          url: pr.html_url,
          fields: [
            { name: gateResult.canMerge ? "マージ可" : "マージ不可", value: statusValue },
            ...(forkWorkflowNotice ? [{ name: "注意", value: forkWorkflowNotice }] : []),
            { name: "Repository", value: inlineCode(repo.fullName) },
            { name: "Author", value: pr.user?.login ?? "unknown", inline: true },
            {
              name: "Branch",
              value: `${inlineCode(getPullRequestHeadRef(pr))} → ${inlineCode(pr.base.ref)}`,
              inline: true,
            },
          ],
          timestamp: nowIso(),
          color: gateResult.canMerge ? EmbedColor.Success : EmbedColor.Warning,
        });
      } catch (err) {
        logCommandError("status", err);
        const msg = getJapaneseErrorMessage(err);
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, msg);
      }
    })
  );

  return c.json(deferredEphemeral());
};
