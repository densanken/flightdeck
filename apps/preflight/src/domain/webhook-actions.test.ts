import { describe, expect, it } from "vitest";

import { triggersAutoAssign } from "./webhook-actions.js";

describe("triggersAutoAssign", () => {
  it.each([
    ["opened", true],
    ["reopened", true],
    ["edited", false],
    ["synchronize", false],
    ["closed", false],
  ])("action %j の実行可否を %s と判定する", (action, expected) => {
    expect(triggersAutoAssign(action)).toBe(expected);
  });
});
