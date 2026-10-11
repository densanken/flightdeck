import { describe, expect, it } from "vitest";

import { ComponentType } from "./constants.js";
import { createPaginationComponents, paginateLines, parseRequestedPage } from "./pagination.js";

const lines = (count: number, length = 2): string[] =>
  Array.from({ length: count }, (_, index) => String(index).padEnd(length, "x"));

describe("Discord list pagination", () => {
  it("1 ページを 10 行までに区切り範囲外ページを補正する", () => {
    expect(paginateLines(lines(21), 1)).toEqual({ index: 1, count: 3, lines: lines(21).slice(10, 20) });
    expect(paginateLines(lines(21), -1).index).toBe(0);
    expect(paginateLines(lines(21), 99)).toEqual({ index: 2, count: 3, lines: ["20"] });
    expect(paginateLines([], 0)).toEqual({ index: 0, count: 1, lines: [] });
  });

  it("改行を含めて description の上限を超える行は次のページへ送る", () => {
    // 1000 文字 4 行と改行 3 文字で 4003 文字、5 行目は上限 4096 を超える
    const pages = [0, 1].map((page) => paginateLines(lines(5, 1000), page));

    expect(pages.map((page) => page.lines.length)).toEqual([4, 1]);
    expect(pages[0]?.lines.join("\n").length).toBeLessThanOrEqual(4096);
    expect(paginateLines(lines(2, 2048), 0).lines).toHaveLength(1);
    expect(paginateLines([...lines(1, 2047), ...lines(1, 2048)], 0).lines).toHaveLength(2);
  });

  it("先頭と末尾で対応する button を無効化する", () => {
    const first = createPaginationComponents("repos.page", paginateLines(lines(21), 0));
    const last = createPaginationComponents("repos.page", paginateLines(lines(21), 2));
    const firstRow = first[0];
    const lastRow = last[0];

    expect(firstRow?.type).toBe(ComponentType.ActionRow);
    expect(lastRow?.type).toBe(ComponentType.ActionRow);
    if (firstRow?.type !== ComponentType.ActionRow || lastRow?.type !== ComponentType.ActionRow) return;

    expect(firstRow.components.map((button) => "disabled" in button && button.disabled)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(lastRow.components.map((button) => "disabled" in button && button.disabled)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("1 ページなら button を返さず custom id からページを取得する", () => {
    expect(createPaginationComponents("repos.page", paginateLines(lines(10), 0))).toEqual([]);
    expect(parseRequestedPage("repos.page:next:2")).toBe(2);
    expect(parseRequestedPage("repos.page:invalid")).toBe(0);
  });
});
