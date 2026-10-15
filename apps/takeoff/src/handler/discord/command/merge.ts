import { errors } from "../../../domain/errors.js";
import { getPullRequestHeadRef } from "../../../usecase/pull-request-branch.js";
import { escapeDiscordMarkdownLinkText, inlineCode } from "../../../util/discord-markdown.js";
import { MAX_EMBED_DESCRIPTION_LENGTH } from "../constants.js";
import { editDeferredResponse, editDeferredWithError, FOLLOWUP_TIMEOUT_MS } from "../followup.js";
import { appendLinesWithinLimit, getJapaneseErrorMessage, getStringOption, parsePrNumber } from "../helpers.js";
import { deferredEphemeral, EmbedColor } from "../interaction-response.js";
import { assertNotLoadingSentinel } from "../timeout-budget.js";

import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/v10";
import type { Context } from "hono";

export const handleMerge = (
  c: Context<Env>,
  interaction: APIChatInputApplicationCommandInteraction,
  deps: DiscordDependencies
): Response => {
  const repoId = getStringOption(interaction.data.options, "repo");
  const prNumberStr = getStringOption(interaction.data.options, "pr");
  // waitUntil の応答後 30 秒から成功通知の timeout と 1 秒の余裕を確保する
  const mergeDeadline = Date.now() + 30_000 - FOLLOWUP_TIMEOUT_MS - 1_000;

  c.executionCtx.waitUntil(
    (async () => {
      try {
        if (!repoId) throw errors.invalidRequest("repo が指定されていません。");
        if (!prNumberStr) throw errors.invalidRequest("pr が指定されていません。");

        // autocomplete が timeout したときの読み込み中候補は実値ではないため、案内へ振り分ける
        assertNotLoadingSentinel(repoId);
        assertNotLoadingSentinel(prNumberStr);

        const prNumber = parsePrNumber(prNumberStr);

        const userId = interaction.member?.user.id ?? interaction.user?.id ?? "unknown";

        const result = await deps.mergeUsecase.merge({
          repoId,
          prNumber,
          discordUserId: userId,
          mergeDeadline,
        });

        const prField = {
          name: "PR",
          value: `[${escapeDiscordMarkdownLinkText(result.pr.title)} (#${String(result.pr.number)})](${result.pr.html_url})`,
        };

        if (result.type === "auto_approved") {
          const runLines = result.approvedRuns.map((run) => {
            const runUrl = `https://github.com/${result.repo.fullName}/actions/runs/${String(run.runId)}`;
            return `- [${escapeDiscordMarkdownLinkText(run.name)}](${runUrl})`;
          });
          await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, {
            title: "Workflow run を承認しました",
            description: appendLinesWithinLimit(
              [
                `承認待ちの workflow run ${String(result.approvedRuns.length)} 件を自動承認しました。`,
                "CI の完了後に再度 `/merge` を実行してください。",
                "",
              ].join("\n"),
              runLines,
              MAX_EMBED_DESCRIPTION_LENGTH
            ),
            fields: [{ name: "Repository", value: inlineCode(result.repo.fullName) }, prField],
            color: EmbedColor.Warning,
          });
          return;
        }

        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, {
          title: "PR をマージしました",
          fields: [
            { name: "Repository", value: inlineCode(result.repo.fullName) },
            prField,
            {
              name: "Branch",
              value: `${inlineCode(getPullRequestHeadRef(result.pr))} → ${inlineCode(result.pr.base.ref)}`,
              inline: true,
            },
            { name: "Merge commit", value: inlineCode(result.sha.slice(0, 7)), inline: true },
          ],
          color: EmbedColor.Success,
        });
        await result.afterMerge();
      } catch (err) {
        const msg = getJapaneseErrorMessage(err);
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, msg);
      }
    })()
  );

  return c.json(deferredEphemeral());
};
