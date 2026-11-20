import { describe, expect, it } from "vitest";

import { readTitleTypeRules } from "./parse.js";

describe("readTitleTypeRules", () => {
  it("reads title type rules from the shared configuration", () => {
    expect(
      readTitleTypeRules([
        {
          path: ".github/flightdeck.yml",
          text: "preflight:\n  title-types:\n    - paths: ['docs/**']\n      types: [docs, content]",
        },
      ])
    ).toEqual([{ paths: ["docs/**"], types: ["docs", "content"] }]);
  });

  it("rejects invalid type names", () => {
    expect(() =>
      readTitleTypeRules([
        {
          path: ".github/flightdeck.yml",
          text: "preflight:\n  title-types:\n    - paths: ['**']\n      types: [Invalid]",
        },
      ])
    ).toThrow();
  });

  it.each(["draft", "wip"])("rejects reserved type %s", (type) => {
    expect(() =>
      readTitleTypeRules([
        {
          path: ".github/flightdeck.yml",
          text: `preflight:\n  title-types:\n    - paths: ['**']\n      types: [${type}]`,
        },
      ])
    ).toThrow();
  });

  it("accepts a missing configuration", () => {
    expect(readTitleTypeRules([])).toBeUndefined();
  });
});
