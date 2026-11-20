import { describe, expect, it } from "vitest";

import { triggersAutoAssign, triggersTitleValidation } from "./webhook-actions.js";

describe("triggersTitleValidation", () => {
  it("base の変更で再検証する", () => {
    expect(triggersTitleValidation("edited", { title: false, base: true })).toBe(true);
    expect(triggersTitleValidation("edited", { title: true, base: false })).toBe(true);
    expect(triggersTitleValidation("edited", { title: false, base: false })).toBe(false);
  });
});

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
