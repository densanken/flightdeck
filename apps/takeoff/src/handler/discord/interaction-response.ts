import { InteractionResponseType, MessageFlags } from "./constants.js";

import type {
  APIEmbed,
  APIInteractionResponse,
  APIInteractionResponseDeferredChannelMessageWithSource,
  APIInteractionResponseDeferredMessageUpdate,
  APIInteractionResponseChannelMessageWithSource,
  APIInteractionResponsePong,
  APIInteractionResponseUpdateMessage,
  APIMessageTopLevelComponent,
} from "discord-api-types/v10";

export const EmbedColor = {
  Default: 0x5865f2,
  Success: 0x57f287,
  Warning: 0xfee75c,
  Error: 0xed4245,
} as const;

export const pongResponse = (): APIInteractionResponsePong => ({
  type: InteractionResponseType.Pong,
});

export const deferredEphemeral = (): APIInteractionResponseDeferredChannelMessageWithSource => ({
  type: InteractionResponseType.DeferredChannelMessageWithSource,
  data: { flags: MessageFlags.Ephemeral },
});

/**
 * message component の応答を deferred にする（response type 6）
 * 元の message をそのまま残したまま応答を確定し、本体の処理と編集を followup へ回す
 */
export const deferredMessageUpdate = (): APIInteractionResponseDeferredMessageUpdate => ({
  type: InteractionResponseType.DeferredMessageUpdate,
});

export const ephemeralEmbed = (
  embed: APIEmbed,
  components?: APIMessageTopLevelComponent[]
): APIInteractionResponseChannelMessageWithSource => ({
  type: InteractionResponseType.ChannelMessageWithSource,
  data: {
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    components,
  },
});

export const updateMessage = (
  embed: APIEmbed,
  components: APIMessageTopLevelComponent[] = []
): APIInteractionResponseUpdateMessage => ({
  type: InteractionResponseType.UpdateMessage,
  data: {
    content: "",
    embeds: [embed],
    components,
  },
});

export const autocompleteResponse = (choices: { name: string; value: string }[]): APIInteractionResponse => ({
  type: InteractionResponseType.ApplicationCommandAutocompleteResult,
  data: { choices },
});
