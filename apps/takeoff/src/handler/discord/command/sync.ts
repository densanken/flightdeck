import { errors } from "../../../domain/errors.js";
import { inlineCode } from "../../../util/discord-markdown.js";
import { withLogContext } from "../../../util/logger.js";
import { editDeferredResponse, editDeferredWithError } from "../followup.js";
import { getJapaneseErrorMessage, logCommandError, getStringOption, resolveRepo } from "../helpers.js";
import { deferredEphemeral, EmbedColor } from "../interaction-response.js";

import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/v10";
import type { Context } from "hono";

export const handleSync = (
  c: Context<Env>,
  interaction: APIChatInputApplicationCommandInteraction,
  deps: DiscordDependencies
): Response => {
  const repoId = getStringOption(interaction.data.options, "repo");

  c.executionCtx.waitUntil(
    withLogContext({ repoId }, async () => {
      try {
        if (!repoId) throw errors.invalidRequest("repo が指定されていません。");

        const repo = await resolveRepo(deps, repoId);
        const userId = interaction.member?.user.id ?? interaction.user?.id ?? "unknown";
        const result = await deps.syncUsecase.sync(repo, userId);

        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, {
          title: "キャッシュを更新しました",
          fields: [
            { name: "Repository", value: inlineCode(repo.fullName) },
            { name: "Open PRs", value: `${String(result.items.length)} 件` },
          ],
          color: EmbedColor.Success,
        });
      } catch (err) {
        logCommandError("sync", err);
        const msg = getJapaneseErrorMessage(err);
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, msg);
      }
    })
  );

  return c.json(deferredEphemeral());
};
