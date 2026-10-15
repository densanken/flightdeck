import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { parseCommaSeparated } from "../../env.js";
import { handleRepoAddAutocomplete } from "./autocomplete/installation-repo.js";
import { handlePrAutocomplete } from "./autocomplete/pr.js";
import { handleRepoAutocomplete } from "./autocomplete/repo.js";
import { handleMerge } from "./command/merge.js";
import { handlePulls, handlePullsPage, isPullsPageInteraction } from "./command/pulls.js";
import { handleRepoAdd, handleRepoRemove, handleRepoRemoveComponent, isRepoRemoveInteraction } from "./command/repo.js";
import { handleRepos, handleReposPage, isReposPageInteraction } from "./command/repos.js";
import { handleStatus } from "./command/status.js";
import { handleSync } from "./command/sync.js";
import { ApplicationCommandOptionType, InteractionType } from "./constants.js";
import { getStringOption, hasAdminRole } from "./helpers.js";
import { autocompleteResponse, EmbedColor, ephemeralEmbed, pongResponse } from "./interaction-response.js";
import { errorDetail } from "../../util/error-detail.js";
import { logger, withLogContext } from "../../util/logger.js";

import type { DiscordDependencies } from "./dependencies.js";
import type { Env } from "../../env.js";
import type {
  APIApplicationCommandAutocompleteInteraction,
  APIApplicationCommandInteractionDataOption,
  APIApplicationCommandInteractionDataStringOption,
  APIApplicationCommandInteractionDataSubcommandOption,
  APIChatInputApplicationCommandInteraction,
  APIInteraction,
  APIMessageComponentInteraction,
  APIPingInteraction,
} from "discord-api-types/v10";

export interface DiscordRouteDependencies {
  createDependencies(env: Env["Bindings"]): DiscordDependencies;
  verifySignature(publicKey: string, signature: string, timestamp: string, body: string): Promise<boolean>;
}

export const createDiscordRoute = (dependencies: DiscordRouteDependencies) => {
  const discord = new Hono<Env>();

  discord.use("/interactions", bodyLimit({ maxSize: 256 * 1024 }));

  const isSubcommandOption = (
    option: APIApplicationCommandInteractionDataOption | undefined
  ): option is APIApplicationCommandInteractionDataSubcommandOption =>
    option?.type === ApplicationCommandOptionType.Subcommand;

  const isStringOption = (
    option: APIApplicationCommandInteractionDataOption | undefined
  ): option is APIApplicationCommandInteractionDataStringOption => option?.type === ApplicationCommandOptionType.String;

  const isPingInteraction = (interaction: APIInteraction): interaction is APIPingInteraction =>
    interaction.type === InteractionType.Ping;

  const isApplicationCommandInteraction = (
    interaction: APIInteraction
  ): interaction is APIChatInputApplicationCommandInteraction =>
    interaction.type === InteractionType.ApplicationCommand;

  const isAutocompleteInteraction = (
    interaction: APIInteraction
  ): interaction is APIApplicationCommandAutocompleteInteraction =>
    interaction.type === InteractionType.ApplicationCommandAutocomplete;

  const isMessageComponentInteraction = (interaction: APIInteraction): interaction is APIMessageComponentInteraction =>
    interaction.type === InteractionType.MessageComponent;

  const isInteraction = (value: unknown): value is APIInteraction =>
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "number";

  const findFocusedAutocompleteOption = (
    interaction: APIApplicationCommandAutocompleteInteraction
  ): { name: string; value: string; commandName: string; subcommandName: string | undefined } | null => {
    for (const option of interaction.data.options) {
      if (isSubcommandOption(option)) {
        for (const subcommandOption of option.options ?? []) {
          if (isStringOption(subcommandOption) && subcommandOption.focused) {
            return {
              name: subcommandOption.name,
              value: subcommandOption.value,
              commandName: interaction.data.name,
              subcommandName: option.name,
            };
          }
        }
      } else if (isStringOption(option) && option.focused) {
        return {
          name: option.name,
          value: option.value,
          commandName: interaction.data.name,
          subcommandName: undefined,
        };
      }
    }
    return null;
  };

  const isRepoAddAutocomplete = (
    interaction: APIApplicationCommandAutocompleteInteraction,
    focused: ReturnType<typeof findFocusedAutocompleteOption>
  ): boolean => interaction.data.name === "repo" && focused?.subcommandName === "add" && focused.name === "full_name";

  const handleCommand = (
    c: import("hono").Context<Env>,
    interaction: APIChatInputApplicationCommandInteraction,
    deps: DiscordDependencies
  ): Response => {
    const commandName = interaction.data.name;

    if (commandName === "merge") return handleMerge(c, interaction, deps);
    if (commandName === "status") return handleStatus(c, interaction, deps);
    if (commandName === "sync") return handleSync(c, interaction, deps);
    if (commandName === "repos") return handleRepos(c, interaction, deps);
    if (commandName === "pulls") return handlePulls(c, interaction, deps);

    if (commandName === "repo") {
      const first = interaction.data.options?.[0];
      if (isSubcommandOption(first)) {
        if (first.name === "add") return handleRepoAdd(c, interaction, first.options, deps);
        if (first.name === "remove") return handleRepoRemove(c, interaction, first.options, deps);
      }
    }

    return c.json(
      ephemeralEmbed({
        title: "未対応のコマンドです",
        description: "Discord コマンドを再登録してから、もう一度実行してください。",
        color: EmbedColor.Error,
      })
    );
  };

  const handleAutocomplete = async (
    c: import("hono").Context<Env>,
    interaction: APIApplicationCommandAutocompleteInteraction,
    deps: DiscordDependencies
  ): Promise<Response> => {
    const commandName = interaction.data.name;
    const focused = findFocusedAutocompleteOption(interaction);
    if (!focused) return c.json(autocompleteResponse([]));

    if (
      (commandName === "merge" || commandName === "status" || commandName === "sync" || commandName === "pulls") &&
      focused.name === "repo"
    ) {
      return handleRepoAutocomplete(c, focused.value, deps);
    }

    if (commandName === "repo" && focused.subcommandName === "remove" && focused.name === "repo") {
      return handleRepoAutocomplete(c, focused.value, deps);
    }

    if (isRepoAddAutocomplete(interaction, focused)) {
      return handleRepoAddAutocomplete(c, focused.value, deps);
    }

    if ((commandName === "merge" || commandName === "status") && focused.name === "pr") {
      const repoId = getStringOption(interaction.data.options, "repo") ?? "";
      return handlePrAutocomplete(c, repoId, focused.value, deps);
    }

    return c.json(autocompleteResponse([]));
  };

  const handleComponent = (
    c: import("hono").Context<Env>,
    interaction: APIMessageComponentInteraction,
    deps: DiscordDependencies
  ): Response => {
    const customId = interaction.data.custom_id;

    if (isReposPageInteraction(customId)) return handleReposPage(c, interaction, deps);
    if (isPullsPageInteraction(customId)) return handlePullsPage(c, interaction, deps);
    if (isRepoRemoveInteraction(customId)) return handleRepoRemoveComponent(c, interaction, deps);

    return c.json(
      ephemeralEmbed({
        title: "未対応の操作です",
        description: "コマンドを最初から実行し直してください。",
        color: EmbedColor.Error,
      })
    );
  };

  const handleInteraction = async (c: import("hono").Context<Env>, interaction: APIInteraction): Promise<Response> => {
    if (isPingInteraction(interaction)) {
      return c.json(pongResponse());
    }

    const guildId = "guild_id" in interaction ? interaction.guild_id : undefined;
    const allowedGuilds = parseCommaSeparated(c.env.ALLOWED_GUILD_IDS);
    if (!guildId || !allowedGuilds.includes(guildId)) {
      if (isAutocompleteInteraction(interaction)) {
        return c.json(autocompleteResponse([]));
      }
      return c.json(
        ephemeralEmbed({
          title: "このサーバーでは利用できません",
          description: "許可された Discord サーバーで実行してください。",
          color: EmbedColor.Error,
        })
      );
    }

    try {
      if (isAutocompleteInteraction(interaction)) {
        const focused = findFocusedAutocompleteOption(interaction);
        if (isRepoAddAutocomplete(interaction, focused)) {
          const adminRoleIds = parseCommaSeparated(c.env.ADMIN_ROLE_IDS);
          if (!hasAdminRole(interaction, adminRoleIds)) {
            return c.json(autocompleteResponse([]));
          }
        }
      }

      const deps = dependencies.createDependencies(c.env);
      if (isApplicationCommandInteraction(interaction)) {
        return handleCommand(c, interaction, deps);
      }

      if (isAutocompleteInteraction(interaction)) {
        return await handleAutocomplete(c, interaction, deps);
      }

      if (isMessageComponentInteraction(interaction)) {
        return handleComponent(c, interaction, deps);
      }
    } catch (error) {
      logger.log("error", { event: "discord_interaction_unhandled_error", error: errorDetail(error) });
      return c.json(
        ephemeralEmbed({
          title: "内部エラーが発生しました",
          description: "しばらく待ってからもう一度実行してください。",
          color: EmbedColor.Error,
        })
      );
    }

    return c.json(
      ephemeralEmbed({
        title: "未対応の操作です",
        description: "コマンドから実行し直してください。",
        color: EmbedColor.Error,
      })
    );
  };

  discord.post("/interactions", async (c) => {
    const signature = c.req.header("x-signature-ed25519");
    const timestamp = c.req.header("x-signature-timestamp");
    if (!signature || !timestamp) {
      return c.json({ type: "invalid_discord_signature", message: "Missing signature headers" }, 401);
    }

    const body = await c.req.text();
    const isValid = await dependencies.verifySignature(c.env.DISCORD_PUBLIC_KEY, signature, timestamp, body);
    if (!isValid) {
      return c.json({ type: "invalid_discord_signature", message: "Invalid signature" }, 401);
    }

    let rawInteraction: unknown;
    try {
      rawInteraction = JSON.parse(body);
    } catch {
      return c.json({ type: "invalid_request", message: "Invalid interaction JSON" }, 400);
    }
    if (!isInteraction(rawInteraction)) {
      return c.json({ type: "invalid_request", message: "Invalid interaction payload" }, 400);
    }
    const interaction = rawInteraction;

    // 同じ interaction の後続処理（waitUntil を含む）の log を interaction ID と実行者で絞り込めるようにする
    const discordUserId = interaction.member?.user.id ?? interaction.user?.id;
    return withLogContext({ interactionId: interaction.id, discordUserId }, () => handleInteraction(c, interaction));
  });

  return discord;
};
