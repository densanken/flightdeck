import { ALLOWED_PR_TITLE_TYPES } from "@flightdeck/pr-title";
import { describe, expect, it } from "vitest";

import { isConfigurableTitleType, titleTypePolicy } from "./title-types.js";

describe("isConfigurableTitleType", () => {
  it.each(["docs", "content2", "release_note", "drafting", "wip2"])("accepts %s", (type) => {
    expect(isConfigurableTitleType(type)).toBe(true);
  });

  it.each(["", "Invalid", "2type", "bad-type", "draft", "wip"])("rejects %s", (type) => {
    expect(isConfigurableTitleType(type)).toBe(false);
  });
});

describe("titleTypePolicy", () => {
  const rules = [
    { paths: ["docs/**", "*.md"], types: ["docs", "content"] },
    { paths: ["src/**"], types: ["feat", "content"] },
  ];

  it("uses the union of matching rules when all files are covered", () => {
    expect(titleTypePolicy({ rules, files: ["docs/a.md", "src/a.ts"], filesComplete: true })).toEqual({
      types: ["docs", "content", "feat"],
      restricted: true,
    });
  });

  it("adds defaults when some files are outside the rules", () => {
    expect(titleTypePolicy({ rules, files: ["docs/a.md", "other/a.ts"], filesComplete: true })).toEqual({
      types: [...ALLOWED_PR_TITLE_TYPES, "content"],
      restricted: false,
    });
  });

  it("uses defaults when no rule matches", () => {
    expect(titleTypePolicy({ rules, files: ["other/a.ts"], filesComplete: true })).toBeUndefined();
  });

  it("matches dotfiles", () => {
    expect(
      titleTypePolicy({
        rules: [{ paths: ["**"], types: ["content"] }],
        files: [".github/config.yml"],
        filesComplete: true,
      })
    ).toEqual({
      types: ["content"],
      restricted: true,
    });
  });

  it("uses defaults for no files or an incomplete file list", () => {
    expect(titleTypePolicy({ rules: undefined, files: ["docs/a.md"], filesComplete: true })).toBeUndefined();
    expect(titleTypePolicy({ rules, files: [], filesComplete: true })).toBeUndefined();
    expect(titleTypePolicy({ rules, files: ["docs/a.md"], filesComplete: false })).toBeUndefined();
  });

  it("deduplicates types when multiple rules match one file", () => {
    expect(
      titleTypePolicy({
        rules: [
          { paths: ["docs/**"], types: ["docs", "content"] },
          { paths: ["**/*.md"], types: ["content", "notes"] },
        ],
        files: ["docs/a.md"],
        filesComplete: true,
      })
    ).toEqual({ types: ["docs", "content", "notes"], restricted: true });
  });

  it("matches *.md only at the root", () => {
    const rootOnly = [{ paths: ["*.md"], types: ["content"] }];

    expect(titleTypePolicy({ rules: rootOnly, files: ["README.md"], filesComplete: true })?.types).toEqual(["content"]);
    expect(titleTypePolicy({ rules: rootOnly, files: ["docs/README.md"], filesComplete: true })).toBeUndefined();
  });
});
