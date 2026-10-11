import { describe, expect, it } from "vitest";

import { isMarkedDraft } from "./pull-request-draft.js";

describe("isMarkedDraft", () => {
  it.each([
    "[DRAFT] some title",
    "[draft] some title",
    "[WIP] some title",
    "[wip] some title",
    "DRAFT: some title",
    "draft: some title",
    "WIP: some title",
    "wip: some title",
    "  [DRAFT] with leading space",
    "  WIP: with leading space",
    "[Draft] mixed case",
    "[Wip] mixed case",
    "Draft: mixed case",
    "Wip: mixed case",
    "[DRAFT]",
    "[WIP]",
    "DRAFT:",
    "WIP:",
    "[DRAFT]no space after bracket",
    "[WIP]no space after bracket",
    "[DRAFT] 日本語のタイトル",
    "WIP: 日本語タイトル",
  ])("draft marker を検出する: %s", (title) => {
    expect(isMarkedDraft(title)).toBe(true);
  });

  it.each([
    "fix: normal title",
    "feat: add feature",
    "Some draft in middle",
    "fix: [WIP] in middle",
    "[下書き] some title",
    "WIP：日本語タイトル",
    "DRAFT some title",
    "WIP some title",
  ])("draft marker でない title を通す: %s", (title) => {
    expect(isMarkedDraft(title)).toBe(false);
  });
});
