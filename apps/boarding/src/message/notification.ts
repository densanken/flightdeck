import { listWithinLimit } from "./list.js";
import { reasonLabels, statusLabels } from "./status.js";
import { editorName } from "../domain/editors.js";

import type { Editor, NewAuthorRoot } from "../domain/editors.js";
import type { EvaluationResult } from "../usecase/evaluate/interface.js";

const safe = (value: string): string => value.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]()#+\-.!|~<>]/g, "\\$&");

export interface DiscordPayload {
  embeds: { title: string; url: string; color: number; fields: { name: string; value: string }[] }[];
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
    prefix: `- ${safe(name)}: `,
    editors,
    fallback: fallbackText(editors),
  }));
  const minimum = rows.reduce((sum, row) => sum + row.prefix.length + row.fallback.length, rows.length - 1);
  if (minimum > 1024) return listWithinLimit(rows, (row) => row.prefix + row.fallback, "\n", 1024);

  let remaining = 1024 - minimum;
  const lines: string[] = [];
  for (const row of rows) {
    const names =
      row.editors === null
        ? row.fallback
        : listWithinLimit(row.editors, (editor) => safe(editorName(editor)), ", ", row.fallback.length + remaining) ||
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

const colors: Record<EvaluationResult["status"], number> = {
  allowed: 0x2ea44f,
  not_applicable: 0x2ea44f,
  waiting: 0xe3b341,
  rejected: 0xcf222e,
  error: 0xcf222e,
};

const payload = (
  title: string,
  number: number,
  color: number,
  fields: DiscordPayload["embeds"][0]["fields"]
): DiscordPayload => ({
  embeds: [{ title, url: url(number), color, fields }],
  allowed_mentions: { parse: [] },
});

export const openedNotification = (input: {
  number: number;
  author: string;
  roots: NewAuthorRoot[];
  result: EvaluationResult;
}): DiscordPayload =>
  payload("著者登録申請", input.number, colors[input.result.status], [
    { name: "申請者", value: safe(input.author).slice(0, 1024) || "不明" },
    { name: "PR", value: `#${String(input.number)}` },
    { name: "AuthorRoot / Editor 候補", value: roots(input.roots) },
    { name: "認可", value: `${statusLabels[input.result.status]}（${reasonLabels[input.result.reason]}）` },
    {
      name: "著者以外の変更",
      value: otherChangesText(input.result.facts),
    },
  ]);

export const mergedNotification = (input: { number: number; roots: NewAuthorRoot[] }): DiscordPayload =>
  payload("著者登録完了", input.number, colors.allowed, [
    { name: "PR", value: `#${String(input.number)}` },
    { name: "AuthorRoot / Editor", value: roots(input.roots) },
  ]);
