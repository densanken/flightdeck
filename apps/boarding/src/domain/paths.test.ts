import { describe, expect, it } from "vitest";

import { classifyPaths, collidingAuthorRoots, newAuthorRoots } from "./paths.js";

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

describe("newAuthorRoots", () => {
  it("削除以外のメタデータを持ち base にない著者を返す", () => {
    expect(
      newAuthorRoots(
        [
          { path: "authors/alice/meta.yaml" },
          { path: "authors/alice/meta.yml" },
          { path: "authors/Bob/meta.yml" },
          { path: "authors/carol/meta.yml", previousPath: "other/meta.yml" },
          { path: "authors/deleted/meta.yaml", removed: true },
          { path: "authors/new/post.md" },
          { path: "authors/nested/sub/meta.yaml" },
        ],
        ["bob"]
      )
    ).toEqual(["alice", "carol"]);
  });
});
