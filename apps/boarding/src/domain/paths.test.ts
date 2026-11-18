import { describe, expect, it } from "vitest";

import { classifyPaths, collidingAuthorRoots } from "./paths.js";

describe("classifyPaths", () => {
  it("移動前後のルートと authors 直下のファイルを分類する", () => {
    expect(
      classifyPaths([
        { path: "authors/bob/new.md", previousPath: "authors/alice/old.md" },
        { path: "authors/README.md" },
        { path: ".github/config.yml" },
      ])
    ).toEqual({ authorRoots: ["bob", "alice"], otherPaths: ["authors/README.md", ".github/config.yml"] });
  });
});

describe("collidingAuthorRoots", () => {
  it("base と変更内で大文字小文字だけが異なるルートを検出する", () => {
    expect(collidingAuthorRoots(["Alice", "bob", "BOB", "carol"], ["alice", "carol"])).toEqual(["Alice", "bob", "BOB"]);
  });
});
