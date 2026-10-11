import { ButtonStyle, ComponentType, MAX_EMBED_DESCRIPTION_LENGTH } from "./constants.js";
import { EmbedColor } from "./interaction-response.js";

import type { APIEmbed, APIMessageTopLevelComponent } from "discord-api-types/v10";

const MAX_LINES_PER_PAGE = 10;

export interface Page {
  index: number;
  count: number;
  lines: string[];
}

// 各ページは 10 行以内かつ改行区切りで embed description の上限に収まるよう先頭から詰める
// 境界は全行だけから決まるため、一覧が変わらない限り button の custom_id に載せたページ番号がそのまま使える
export const paginateLines = (lines: readonly string[], requestedPage: number): Page => {
  let current: string[] = [];
  const pages = [current];
  for (const line of lines) {
    if (
      current.length === MAX_LINES_PER_PAGE ||
      (current.length > 0 && [...current, line].join("\n").length > MAX_EMBED_DESCRIPTION_LENGTH)
    ) {
      current = [];
      pages.push(current);
    }
    current.push(line);
  }

  const index = Math.min(Math.max(0, requestedPage), pages.length - 1);
  return { index, count: pages.length, lines: pages[index] ?? [] };
};

export const createPaginationComponents = (customIdPrefix: string, page: Page): APIMessageTopLevelComponent[] =>
  page.count === 1
    ? []
    : [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: "<<",
              custom_id: `${customIdPrefix}:first:0`,
              disabled: page.index === 0,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: "<",
              custom_id: `${customIdPrefix}:previous:${String(page.index - 1)}`,
              disabled: page.index === 0,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: ">",
              custom_id: `${customIdPrefix}:next:${String(page.index + 1)}`,
              disabled: page.index === page.count - 1,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: ">>",
              custom_id: `${customIdPrefix}:last:${String(page.count - 1)}`,
              disabled: page.index === page.count - 1,
            },
          ],
        },
      ];

export interface PaginatedEmbed {
  embed: APIEmbed;
  components: APIMessageTopLevelComponent[];
}

// 一覧の 1 ページ分を embed にし、複数ページのときだけ footer とページ送り button を付ける
export const buildPaginatedEmbed = (params: {
  title: string;
  lines: readonly string[];
  emptyDescription: string;
  requestedPage: number;
  customIdPrefix: string;
}): PaginatedEmbed => {
  const page = paginateLines(params.lines, params.requestedPage);
  return {
    embed: {
      title: params.title,
      description: page.lines.length === 0 ? params.emptyDescription : page.lines.join("\n"),
      color: EmbedColor.Default,
      footer: page.count > 1 ? { text: `${String(page.index + 1)} / ${String(page.count)}` } : undefined,
    },
    components: createPaginationComponents(params.customIdPrefix, page),
  };
};

export const parseRequestedPage = (customId: string): number => {
  const value = customId.split(":").at(-1);
  if (value === undefined) return 0;

  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) ? page : 0;
};
