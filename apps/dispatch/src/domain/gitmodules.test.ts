import { describe, expect, it } from "vitest";

import { findSubmodule } from "./gitmodules.js";

const submodule = (url: string) => ({ path: "vendor", url, commitSha: "P" });

describe("submodule の選択", () => {
  it.each(["https://github.com/Owner/Repo.git", "git@github.com:owner/repo.git", "ssh://git@github.com/OWNER/REPO"])(
    "URL %s を正規化して照合する",
    (url) => {
      expect(findSubmodule([submodule(url)], "owner/repo", "o/parent").path).toBe("vendor");
    }
  );

  it.each([[[]], [[submodule("https://github.com/o/r"), submodule("git@github.com:o/r.git")]]])(
    "一致が 1 件でなければ設定エラーにする",
    (items) => {
      expect(() => findSubmodule(items, "o/r", "o/parent")).toThrow(expect.objectContaining({ kind: "config" }));
    }
  );
});
