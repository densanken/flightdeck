import { errors } from "../../../domain/errors.js";
import { parseCommaSeparated } from "../../../env.js";
import { inlineCode } from "../../../util/discord-markdown.js";
import { withLogContext } from "../../../util/logger.js";
import { ButtonStyle, ComponentType } from "../constants.js";
import { editDeferredResponse, editDeferredWithError } from "../followup.js";
import { getJapaneseErrorMessage, logCommandError, getStringOption, hasAdminRole, resolveRepo } from "../helpers.js";
import { deferredEphemeral, deferredMessageUpdate, EmbedColor, updateMessage } from "../interaction-response.js";
import { assertNotLoadingSentinel } from "../timeout-budget.js";

import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type {
  APIApplicationCommandInteractionDataBasicOption,
  APIChatInputApplicationCommandInteraction,
  APIMessageComponentInteraction,
} from "discord-api-types/v10";
import type { Context } from "hono";

const REMOVE_CONFIRM_PREFIX = "repo.remove.confirm";
const REMOVE_CANCEL_PREFIX = "repo.remove.cancel";

export const handleRepoAdd = (
  c: Context<Env>,
  interaction: APIChatInputApplicationCommandInteraction,
  subcommandOptions: APIApplicationCommandInteractionDataBasicOption[] | undefined,
  deps: DiscordDependencies
): Response => {
  const fullName = getStringOption(subcommandOptions, "full_name");

  c.executionCtx.waitUntil(
    withLogContext({ repository: fullName }, async () => {
      try {
        const adminRoleIds = parseCommaSeparated(c.env.ADMIN_ROLE_IDS);
        if (!hasAdminRole(interaction, adminRoleIds)) {
          throw errors.roleRequired();
        }

        if (!fullName) throw errors.invalidRequest("full_name が指定されていません。");
        // autocomplete が timeout したときの読み込み中候補は full_name ではないため、案内へ振り分ける
        assertNotLoadingSentinel(fullName);

        // autocomplete は value の 100 文字上限に収めるため repository 名だけを送る
        // owner を省いた入力は org 配下の repository として扱う
        const parts = fullName.split("/");
        const [owner, repoName] = parts.length === 1 ? [c.env.GITHUB_ORG, ...parts] : parts;
        if (parts.length > 2 || !owner || !repoName) {
          throw errors.invalidRequest("full_name は repo または owner/repo 形式で指定してください。");
        }

        // GitHub の login は大文字小文字を区別しないため、reconcile と同じく小文字で比べる
        if (owner.toLowerCase() !== c.env.GITHUB_ORG.toLowerCase()) {
          throw errors.invalidRequest(`${c.env.GITHUB_ORG} organization 配下のリポジトリを指定してください。`);
        }

        const registered = await deps.repositoryAdminUsecase.addRepository(owner, repoName);

        await editDeferredResponse(c.env.DISCORD_APPLICATION_ID, interaction.token, {
          title: "リポジトリを登録しました",
          description: `${inlineCode(registered.fullName)} を登録しました。`,
          color: EmbedColor.Success,
        });
      } catch (err) {
        logCommandError("repo_add", err);
        const msg = getJapaneseErrorMessage(err);
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, msg);
      }
    })
  );

  return c.json(deferredEphemeral());
};

export const handleRepoRemove = (
  c: Context<Env>,
  interaction: APIChatInputApplicationCommandInteraction,
  subcommandOptions: APIApplicationCommandInteractionDataBasicOption[] | undefined,
  deps: DiscordDependencies
): Response => {
  const repoId = getStringOption(subcommandOptions, "repo");

  c.executionCtx.waitUntil(
    withLogContext({ repoId }, async () => {
      try {
        const adminRoleIds = parseCommaSeparated(c.env.ADMIN_ROLE_IDS);
        if (!hasAdminRole(interaction, adminRoleIds)) {
          throw errors.roleRequired();
        }

        if (!repoId) throw errors.invalidRequest("repo が指定されていません。");

        // 読み込み中候補の振り分けと未登録の判定を resolveRepo に集約する
        const repo = await resolveRepo(deps, repoId);

        await editDeferredResponse(
          c.env.DISCORD_APPLICATION_ID,
          interaction.token,
          {
            title: "リポジトリの登録を解除しますか？",
            description: `${inlineCode(repo.fullName)} をマージ対象から外します。`,
            color: EmbedColor.Default,
          },
          [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Danger,
                  label: "解除する",
                  custom_id: `${REMOVE_CONFIRM_PREFIX}:${repo.repoId}`,
                },
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Secondary,
                  label: "キャンセル",
                  custom_id: `${REMOVE_CANCEL_PREFIX}:${repo.repoId}`,
                },
              ],
            },
          ]
        );
      } catch (err) {
        logCommandError("repo_remove", err);
        const msg = getJapaneseErrorMessage(err);
        await editDeferredWithError(c.env.DISCORD_APPLICATION_ID, interaction.token, msg);
      }
    })
  );

  return c.json(deferredEphemeral());
};

export const isRepoRemoveInteraction = (customId: string): boolean =>
  customId.startsWith(`${REMOVE_CONFIRM_PREFIX}:`) || customId.startsWith(`${REMOVE_CANCEL_PREFIX}:`);

export const handleRepoRemoveComponent = (
  c: Context<Env>,
  interaction: APIMessageComponentInteraction,
  deps: DiscordDependencies
): Response => {
  const customId = interaction.data.custom_id;
  const repoId = customId.split(":").at(-1);

  // キャンセルは I/O を伴わないため、同期の update で確定してボタンを取り除く
  if (customId.startsWith(`${REMOVE_CANCEL_PREFIX}:`)) {
    return c.json(
      updateMessage({
        title: "リポジトリの登録解除をキャンセルしました",
        color: EmbedColor.Default,
      })
    );
  }

  // 解除は KV の get / delete と index 再構築を伴い 3 秒に収まらないことがあるため、
  // deferred update で応答を確定してから followup で結果を書き戻す
  c.executionCtx.waitUntil(
    withLogContext({ repoId }, async () => {
      try {
        const adminRoleIds = parseCommaSeparated(c.env.ADMIN_ROLE_IDS);
        if (!hasAdminRole(interaction, adminRoleIds)) {
          throw errors.roleRequired();
        }
        if (!repoId) throw errors.invalidRequest("リポジトリを特定できません。");

        const repo = await resolveRepo(deps, repoId);

        const removed = await deps.repositoryAdminUsecase.removeRepository(repoId);
        if (!removed) throw errors.repoNotRegistered();

        await editDeferredResponse(
          c.env.DISCORD_APPLICATION_ID,
          interaction.token,
          {
            title: "リポジトリの登録を解除しました",
            description: `${inlineCode(repo.fullName)} の登録を解除しました。`,
            color: EmbedColor.Success,
          },
          // 解除済みの確認ボタンを再度押せないよう、components を空にして取り除く
          []
        );
      } catch (error) {
        logCommandError("repo_remove_confirm", error);
        await editDeferredResponse(
          c.env.DISCORD_APPLICATION_ID,
          interaction.token,
          {
            title: "エラー",
            description: getJapaneseErrorMessage(error),
            color: EmbedColor.Error,
          },
          []
        );
      }
    })
  );

  return c.json(deferredMessageUpdate());
};
