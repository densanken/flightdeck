import { describe, expect, it } from "vitest";

import { buildPullsPage } from "./pulls.js";
import { buildReposPage } from "./repos.js";

import type { CachedPullRequestList } from "../../../domain/pull-request.js";
import type { RegisteredRepository, RepositoryIndex } from "../../../domain/repository.js";

const repository: RegisteredRepository = {
  repoId: "123",
  owner: "org",
  name: "repo",
  fullName: "org/repo",
  htmlUrl: "https://github.com/org/repo",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("Discord list page builders", () => {
  it("repository を 10 件ずつ表示する", () => {
    const index: RepositoryIndex = {
      items: Array.from({ length: 11 }, (_, index) => ({
        repoId: String(index),
        owner: "org",
        name: `repo-${String(index).padStart(2, "0")}`,
        fullName: `org/repo-${String(index).padStart(2, "0")}`,
        htmlUrl: `https://github.com/org/repo-${String(index)}`,
      })),
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    const first = buildReposPage(index, 0);
    const second = buildReposPage(index, 1);

    expect(first.embed.description?.match(/^- /gm)).toHaveLength(10);
    expect(first.embed.footer?.text).toBe("1 / 2");
    expect(first.components).toHaveLength(1);
    expect(second.embed.description?.match(/^- /gm)).toHaveLength(1);
    expect(second.embed.footer?.text).toBe("2 / 2");
  });

  it("PR を更新日時の降順で表示し repository ID を button へ含める", () => {
    const pullRequests: CachedPullRequestList = {
      repoId: repository.repoId,
      fetchedAt: "2026-06-02T00:00:00.000Z",
      items: Array.from({ length: 11 }, (_, index) => ({
        number: index + 1,
        title: `PR ${String(index + 1)}`,
        htmlUrl: `https://github.com/org/repo/pull/${String(index + 1)}`,
        authorLogin: "user",
        headRef: "feature",
        baseRef: "main",
        updatedAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      })),
    };

    const first = buildPullsPage(repository, pullRequests, 0);
    const row = first.components[0];

    expect(first.embed.description).toContain("- [PR 11 (#11)](https://github.com/org/repo/pull/11)");
    expect(first.embed.description).not.toContain("PR 1 (#1)");
    expect(
      row &&
        "components" in row &&
        row.components.every((component) => {
          return "custom_id" in component && component.custom_id.includes(`pulls.page:${repository.repoId}:`);
        })
    ).toBe(true);
  });

  it("長い PR title では link を途中で切らずに残りを次のページへ送る", () => {
    // escape で 512 文字になる title が 10 件あると 1 ページの description が上限を超える
    const pullRequests: CachedPullRequestList = {
      repoId: repository.repoId,
      fetchedAt: "2026-06-02T00:00:00.000Z",
      items: Array.from({ length: 10 }, (_, index) => ({
        number: index + 1,
        title: "[".repeat(256),
        htmlUrl: `https://github.com/org/repo/pull/${String(index + 1)}`,
        authorLogin: "user",
        headRef: "feature",
        baseRef: "main",
        updatedAt: "2026-06-01T00:00:00.000Z",
      })),
    };

    const pages = [0, 1].map((page) => buildPullsPage(repository, pullRequests, page));
    const descriptions = pages.map((page) => page.embed.description ?? "");

    expect(descriptions.every((description) => description.length <= 4096)).toBe(true);
    expect(descriptions.join("\n").match(/\]\(https:\/\/github\.com\/org\/repo\/pull\/\d+\)$/gm)).toHaveLength(10);
    expect(pages[1]?.embed.footer?.text).toBe("2 / 2");
  });

  it("PR title の markdown link 記法を escape する", () => {
    const pullRequests: CachedPullRequestList = {
      repoId: repository.repoId,
      fetchedAt: "2026-06-02T00:00:00.000Z",
      items: [
        {
          number: 1,
          title: "fix: x](https://evil.example)[",
          htmlUrl: "https://github.com/org/repo/pull/1",
          authorLogin: "user",
          headRef: "feature",
          baseRef: "main",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    };

    const first = buildPullsPage(repository, pullRequests, 0);

    expect(first.embed.description).toContain("x\\](https://evil.example)\\[");
  });
});
