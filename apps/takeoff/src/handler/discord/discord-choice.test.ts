import { describe, expect, it } from "vitest";

import { truncateChoiceName } from "./discord-choice.js";

describe("truncateChoiceName", () => {
  it("100 文字までは変えず、101 文字以上は末尾を … にして 100 文字に収める", () => {
    expect(truncateChoiceName("a".repeat(100))).toBe("a".repeat(100));
    expect(truncateChoiceName("a".repeat(101))).toBe(`${"a".repeat(99)}…`);
  });
});
