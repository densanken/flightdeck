import { editDeferredResponse, editDeferredWithError } from "../followup.js";
import { getJapaneseErrorMessage } from "../helpers.js";
import { deferredEphemeral, deferredMessageUpdate } from "../interaction-response.js";
import { buildPaginatedEmbed, parseRequestedPage } from "../pagination.js";

import type { RepositoryIndex } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { PaginatedEmbed } from "../pagination.js";
import type { APIChatInputApplicationCommandInteraction, APIMessageComponentInteraction } from "discord-api-types/v10";
import type { Context } from "hono";

const PAGE_CUSTOM_ID_PREFIX = "repos.page";

export const buildReposPage = (index: RepositoryIndex, requestedPage: number): PaginatedEmbed => {
  const items = [...index.items].sort((left, right) => left.fullName.localeCompare(right.fullName));
  return buildPaginatedEmbed({
    title: "登録済みリポジトリ",
    lines: items.map((item) => `- [${item.fullName}](${item.htmlUrl})`),
    emptyDescription: "登録済みのリポジトリがありません。",
    requestedPage,
    customIdPrefix: PAGE_CUSTOM_ID_PREFIX,
  });
};

export const handleRepos = (
  c: Context<Env>,
  interaction: APIChatInputApplicationCommandInteraction,
  deps: DiscordDependencies
): Response => {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const page = buildReposPage(await deps.repositoryAdminUsecase.getRepositoryIndex(), 0);
        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, page.embed, page.components);
      } catch (error) {
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, getJapaneseErrorMessage(error));
      }
    })()
  );

  return c.json(deferredEphemeral());
};

// message component の応答も 3 秒以内に返す必要がある
// cache miss では KV の全件 list が入るため、
// 同期で返さず deferred update にして本体の処理を followup へ回す
export const handleReposPage = (
  c: Context<Env>,
  interaction: APIMessageComponentInteraction,
  deps: DiscordDependencies
): Response => {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const page = buildReposPage(
          await deps.repositoryAdminUsecase.getRepositoryIndex(),
          parseRequestedPage(interaction.data.custom_id)
        );
        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, page.embed, page.components);
      } catch (error) {
        // components を送らないため既存のページ送りボタンは残る
        // 一時的な失敗をそのまま押し直せる
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, getJapaneseErrorMessage(error));
      }
    })()
  );

  return c.json(deferredMessageUpdate());
};

export const isReposPageInteraction = (customId: string): boolean => customId.startsWith(`${PAGE_CUSTOM_ID_PREFIX}:`);
