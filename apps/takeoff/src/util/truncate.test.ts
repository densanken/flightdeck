import { describe, expect, it } from "vitest";

import { truncateText } from "./truncate.js";

describe("truncateText", () => {
  it("上限までは変えず、超える分は末尾を … にして上限に収める", () => {
    expect(truncateText("a".repeat(10), 10)).toBe("a".repeat(10));
    expect(truncateText("a".repeat(11), 10)).toBe(`${"a".repeat(9)}…`);
  });

  it("切る位置にある絵文字を分断せず、手前で切る", () => {
    // 😀 は UTF-16 で 2 code unit なので、固定位置で切ると上位サロゲートだけが残る
    expect(truncateText(`${"a".repeat(8)}😀b`, 10)).toBe(`${"a".repeat(8)}…`);
    // ZWJ でつないだ絵文字も 1 文字として扱う
    expect(truncateText(`a👨‍👩‍👧b`, 5)).toBe("a…");
  });
});
