import { listWithinLimit } from "./list.js";
import { reasonLabels, statusLabels } from "./status.js";
import { editorName } from "../domain/editors.js";

import type { Editor, NewAuthorRoot } from "../domain/editors.js";
import type { EvaluationResult } from "../usecase/evaluate/interface.js";

// 中の ` より長い区切りで囲み、Markdown として解釈させない
const code = (value: string): string => {
  const text = value.replace(/[\r\n]/g, " ");
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
};

// Components V2 を使うことを示す message flag（IS_COMPONENTS_V2）
const COMPONENTS_V2 = 1 << 15;

// Text Display の文字数は 1 通の合計で 4000 文字までなので、可変の一覧に割り当てる上限
const ROOTS_LIMIT = 3_000;

const APPLICATION_COLOR = 0x5865f2;
const MERGED_COLOR = 0x2ea44f;

interface TextDisplay {
  type: 10;
  content: string;
}

interface Separator {
  type: 14;
  divider: true;
  spacing: 1;
}

export interface DiscordPayload {
  flags: number;
  components: { type: 17; accent_color: number; components: (TextDisplay | Separator)[] }[];
  allowed_mentions: { parse: never[] };
}

const fallbackText = (editors: Editor[] | null): string => {
  if (editors === null) return "確認できません";
  if (editors.length === 0) return "なし";
  return `…ほか ${String(editors.length)} 件`;
};

const roots = (items: NewAuthorRoot[]): string => {
  if (!items.length) return "なし";

  const rows = items.map(({ name, editors }) => ({
    prefix: `- ${code(`authors/${name}/`)}: `,
    editors,
    fallback: fallbackText(editors),
  }));
  const minimum = rows.reduce((sum, row) => sum + row.prefix.length + row.fallback.length, rows.length - 1);
  if (minimum > ROOTS_LIMIT) return listWithinLimit(rows, (row) => row.prefix + row.fallback, "\n", ROOTS_LIMIT);

  let remaining = ROOTS_LIMIT - minimum;
  const lines: string[] = [];
  for (const row of rows) {
    const names =
      row.editors === null
        ? row.fallback
        : listWithinLimit(row.editors, (editor) => code(editorName(editor)), ", ", row.fallback.length + remaining) ||
          row.fallback;
    remaining -= names.length - row.fallback.length;
    lines.push(row.prefix + names);
  }
  return lines.join("\n");
};

const otherChangesText = (facts: EvaluationResult["facts"]): string => {
  if (!facts) return "確認できません";
  if (facts.otherPaths.length > 0) return "あり";
  return "なし";
};

const url = (number: number): string => `https://github.com/densanken/blog-contents/pull/${String(number)}`;

const pullRequestLink = (number: number): string => `[#${String(number)}](${url(number)})`;

const separator: Separator = { type: 14, divider: true, spacing: 1 };

// 先頭のセクションを題名として、セクションの間に区切り線を入れる
const payload = (color: number, sections: string[]): DiscordPayload => ({
  flags: COMPONENTS_V2,
  components: [
    {
      type: 17,
      accent_color: color,
      components: sections.flatMap((content, index): (TextDisplay | Separator)[] => {
        const text: TextDisplay = { type: 10, content };
        return index === 0 ? [text] : [separator, text];
      }),
    },
  ],
  allowed_mentions: { parse: [] },
});

export const openedNotification = (input: {
  number: number;
  author: string;
  roots: NewAuthorRoot[];
  result: EvaluationResult;
}): DiscordPayload =>
  payload(APPLICATION_COLOR, [
    `## 執筆者の登録申請\n${statusLabels[input.result.status]}（${reasonLabels[input.result.reason]}）`,
    // Components V2 には横に並べる部品がないため、PR と PR Author を 1 行に並べる
    `**PR** ${pullRequestLink(input.number)} · **PR Author** ${input.author ? code(input.author.slice(0, 100)) : "不明"}`,
    `**新しいディレクトリと Editor の候補**\n${roots(input.roots)}`,
    `**\`authors/\` 以外の変更**\n${otherChangesText(input.result.facts)}`,
  ]);

export const mergedNotification = (input: { number: number; roots: NewAuthorRoot[] }): DiscordPayload =>
  payload(MERGED_COLOR, [
    "## 執筆者の登録完了",
    `**PR**\n${pullRequestLink(input.number)}`,
    `**ディレクトリと Editor**\n${roots(input.roots)}`,
  ]);
