import { ApplicationCommandOptionType, ApplicationCommandType } from "./constants.js";

import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

export const commands: RESTPostAPIApplicationCommandsJSONBody[] = [
  {
    name: "merge",
    description: "PR をマージする",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: "repo",
        description: "リポジトリ",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
      {
        name: "pr",
        description: "PR 番号",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "status",
    description: "PR のマージ可否を確認し、承認待ち workflow run を承認する",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: "repo",
        description: "リポジトリ",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
      {
        name: "pr",
        description: "PR 番号",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "sync",
    description: "リポジトリの PR 一覧のキャッシュを更新する",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: "repo",
        description: "リポジトリ",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "repos",
    description: "登録済みリポジトリ一覧を表示する",
    type: ApplicationCommandType.ChatInput,
  },
  {
    name: "pulls",
    description: "Open PR 一覧を表示する",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: "repo",
        description: "リポジトリ",
        type: ApplicationCommandOptionType.String,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "repo",
    description: "リポジトリ管理",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: "add",
        description: "リポジトリを登録する",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "full_name",
            description: "リポジトリ名（owner/repo 形式も可）",
            type: ApplicationCommandOptionType.String,
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        name: "remove",
        description: "リポジトリの登録を解除する",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "repo",
            description: "リポジトリ",
            type: ApplicationCommandOptionType.String,
            required: true,
            autocomplete: true,
          },
        ],
      },
    ],
  },
];
