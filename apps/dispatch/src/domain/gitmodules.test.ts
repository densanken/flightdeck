import { describe, expect, it } from "vitest";

import { normalizeGitHubUrl } from "./gitmodules.js";

describe("normalizeGitHubUrl", () => {
  it.each([
    "https://github.com/Owner/Repo",
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo",
  ])("%s を owner/repo に正規化する", (url) => {
    expect(normalizeGitHubUrl(url)).toBe("owner/repo");
  });

  it.each(["../repo", "https://gitlab.com/owner/repo", "http://github.com/owner/repo", "https://github.com/owner"])(
    "%s は対象外",
    (url) => {
      expect(normalizeGitHubUrl(url)).toBeNull();
    }
  );
});

describe("normalizeGitHubUrl の細部", () => {
  it("owner と repo の文字種を満たさない URL は対象外", () => {
    expect(normalizeGitHubUrl("https://github.com/o/..")).toBeNull();
    expect(normalizeGitHubUrl("https://github.com/o/r%20x")).toBeNull();
  });
});
