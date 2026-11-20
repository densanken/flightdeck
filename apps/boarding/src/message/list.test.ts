import { describe, expect, it } from "vitest";

import { listWithinLimit } from "./list.js";

describe("文字数制限付きの一覧", () => {
  it("収まらない項目を件数で示す", () => {
    const value = listWithinLimit(["aaa", "bbb", "ccc", "ddd"], (item) => item, "\n", 12);
    expect(value).toBe("aaa\n…ほか 3 件");
    expect(value.length).toBeLessThanOrEqual(12);
  });

  it("最後まで収まる項目は省略しない", () => {
    expect(listWithinLimit(["a", "b"], (item) => item, ", ", 4)).toBe("a, b");
  });

  it("一部を省略して件数が増える場合も上限に収める", () => {
    const value = listWithinLimit(
      Array.from({ length: 20 }, () => "aa"),
      (item) => item,
      ", ",
      20
    );
    expect(value).toBe("aa, aa, aa, …ほか 17 件");
    expect(value.length).toBeLessThanOrEqual(20);
  });
});
