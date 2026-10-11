// discord-api-types/v10 の ESM entry は CJS の再 export で tree shaking が効かず、
// enum を 1 つ import するだけで v10 の runtime 全体が bundle に入るため、数値リテラルで再定義する
// 型注釈の enum member 型により、値のずれは tsc が検出する
/* eslint-disable @typescript-eslint/no-unsafe-enum-assignment -- enum member 型の注釈で値のずれを tsc に検出させるため、数値リテラルを代入する */
import type {
  ApplicationCommandOptionType as _ApplicationCommandOptionType,
  ApplicationCommandType as _ApplicationCommandType,
  ButtonStyle as _ButtonStyle,
  ComponentType as _ComponentType,
  InteractionResponseType as _InteractionResponseType,
  InteractionType as _InteractionType,
  MessageFlags as _MessageFlags,
} from "discord-api-types/v10";

export const InteractionType: {
  readonly Ping: _InteractionType.Ping;
  readonly ApplicationCommand: _InteractionType.ApplicationCommand;
  readonly MessageComponent: _InteractionType.MessageComponent;
  readonly ApplicationCommandAutocomplete: _InteractionType.ApplicationCommandAutocomplete;
} = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ApplicationCommandAutocomplete: 4,
};

export const InteractionResponseType: {
  readonly Pong: _InteractionResponseType.Pong;
  readonly ChannelMessageWithSource: _InteractionResponseType.ChannelMessageWithSource;
  readonly DeferredChannelMessageWithSource: _InteractionResponseType.DeferredChannelMessageWithSource;
  readonly DeferredMessageUpdate: _InteractionResponseType.DeferredMessageUpdate;
  readonly UpdateMessage: _InteractionResponseType.UpdateMessage;
  readonly ApplicationCommandAutocompleteResult: _InteractionResponseType.ApplicationCommandAutocompleteResult;
} = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredMessageUpdate: 6,
  UpdateMessage: 7,
  ApplicationCommandAutocompleteResult: 8,
};

export const ApplicationCommandType: {
  readonly ChatInput: _ApplicationCommandType.ChatInput;
} = {
  ChatInput: 1,
};

export const ApplicationCommandOptionType: {
  readonly Subcommand: _ApplicationCommandOptionType.Subcommand;
  readonly String: _ApplicationCommandOptionType.String;
} = {
  Subcommand: 1,
  String: 3,
};

export const MessageFlags: {
  readonly Ephemeral: _MessageFlags.Ephemeral;
} = {
  Ephemeral: 64,
};

export const ComponentType: {
  readonly ActionRow: _ComponentType.ActionRow;
  readonly Button: _ComponentType.Button;
} = {
  ActionRow: 1,
  Button: 2,
};

export const ButtonStyle: {
  readonly Secondary: _ButtonStyle.Secondary;
  readonly Danger: _ButtonStyle.Danger;
} = {
  Secondary: 2,
  Danger: 4,
};

// Discord の embed の文字数上限
export const MAX_EMBED_TITLE_LENGTH = 256;
export const MAX_EMBED_DESCRIPTION_LENGTH = 4096;
export const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;
