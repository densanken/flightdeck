import { errors } from "../../../domain/errors.js";
import { escapeDiscordMarkdownLinkText, inlineCode } from "../../../util/discord-markdown.js";
import { withLogContext } from "../../../util/logger.js";
import { editDeferredResponse, editDeferredWithError } from "../followup.js";
import { getJapaneseErrorMessage, logCommandError, getStringOption, resolveRepo } from "../helpers.js";
import { deferredEphemeral, deferredMessageUpdate } from "../interaction-response.js";
import { buildPaginatedEmbed, parseRequestedPage } from "../pagination.js";

import type { CachedPullRequestList } from "../../../domain/pull-request.js";
import type { RegisteredRepository } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { PaginatedEmbed } from "../pagination.js";
import type { APIChatInputApplicationCommandInteraction, APIMessageComponentInteraction } from "discord-api-types/v10";
import type { Context } from "hono";

const PAGE_CUSTOM_ID_PREFIX = "pulls.page";

export const buildPullsPage = (
  repo: RegisteredRepository,
  pullRequests: CachedPullRequestList,
  requestedPage: number
): PaginatedEmbed => {
  const items = [...pullRequests.items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return buildPaginatedEmbed({
    title: `Open PRs: ${inlineCode(repo.fullName)}`,
    lines: items.map((pr) => `- [${escapeDiscordMarkdownLinkText(pr.title)} (#${String(pr.number)})](${pr.htmlUrl})`),
    emptyDescription: "Open PR がありません。",
    requestedPage,
    customIdPrefix: `${PAGE_CUSTOM_ID_PREFIX}:${repo.repoId}`,
  });
};

const loadPullsPage = async (deps: DiscordDependencies, repoId: string, requestedPage: number) => {
  const repo = await resolveRepo(deps, repoId);
  const pullRequests = await deps.pullRequestUsecase.listOpenPullRequests(repo.owner, repo.name, repo.repoId);
  return buildPullsPage(repo, pullRequests, requestedPage);
};

export const handlePulls = (
  c: Context<Env>,
  interaction: APIChatInputApplicationCommandInteraction,
  deps: DiscordDependencies
): Response => {
  const repoId = getStringOption(interaction.data.options, "repo");

  c.executionCtx.waitUntil(
    withLogContext({ repoId }, async () => {
      try {
        if (!repoId) throw errors.invalidRequest("repo が指定されていません。");

        const page = await loadPullsPage(deps, repoId, 0);
        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, page.embed, page.components);
      } catch (error) {
        logCommandError("pulls", error);
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, getJapaneseErrorMessage(error));
      }
    })
  );

  return c.json(deferredEphemeral());
};

// message component の応答も 3 秒以内に返す必要がある
// cache miss では KV get と GitHub API が入るため、
// 同期で返さず deferred update にして本体の処理を followup へ回す
export const handlePullsPage = (
  c: Context<Env>,
  interaction: APIMessageComponentInteraction,
  deps: DiscordDependencies
): Response => {
  const repoId = interaction.data.custom_id.split(":").at(-3);

  c.executionCtx.waitUntil(
    withLogContext({ repoId }, async () => {
      try {
        if (!repoId) throw errors.invalidRequest("リポジトリを特定できません。");

        const page = await loadPullsPage(deps, repoId, parseRequestedPage(interaction.data.custom_id));
        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, page.embed, page.components);
      } catch (error) {
        // components を送らないため既存のページ送りボタンは残る
        // 一時的な失敗をそのまま押し直せる
        logCommandError("pulls_page", error);
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, getJapaneseErrorMessage(error));
      }
    })
  );

  return c.json(deferredMessageUpdate());
};

export const isPullsPageInteraction = (customId: string): boolean => customId.startsWith(`${PAGE_CUSTOM_ID_PREFIX}:`);
