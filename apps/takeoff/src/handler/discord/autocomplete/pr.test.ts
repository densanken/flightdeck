import { describe, expect, it, vi } from "vitest";

import { handlePrAutocomplete } from "./pr.js";

import type { CachedPullRequest } from "../../../domain/pull-request.js";
import type { RepositoryIndex } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { Context } from "hono";

const index: RepositoryIndex = {
  items: [{ repoId: "repo-1", owner: "org", name: "repo", fullName: "org/repo", htmlUrl: "https://example.com" }],
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const makePr = (number: number, title: string, author: string): CachedPullRequest => ({
  number,
  title,
  htmlUrl: `https://github.com/org/repo/pull/${String(number)}`,
  authorLogin: author,
  headRef: "feature",
  baseRef: "main",
  updatedAt: "2024-01-01T00:00:00Z",
});

const samplePrs = [
  makePr(1, "feat: add login", "alice"),
  makePr(2, "fix: resolve crash", "bob"),
  makePr(3, "chore: update deps", "alice"),
  makePr(123, "refactor: auth module", "charlie"),
];

const context = { json: (value: unknown) => value as Response } as unknown as Context<Env>;

// 入力値に対して返る autocomplete 候補を返す
const choicesFor = async (
  focusedValue: string,
  items: CachedPullRequest[] = samplePrs
): Promise<{ name: string; value: string }[]> => {
  const deps = {
    repositoryAdminUsecase: { getCachedRepositoryIndex: vi.fn().mockResolvedValue(index) },
    pullRequestUsecase: {
      getCachedPullRequestList: vi
        .fn()
        .mockResolvedValue({ repoId: "repo-1", fetchedAt: "2026-08-12T00:00:00.000Z", items }),
    },
  } as unknown as DiscordDependencies;

  const res = (await handlePrAutocomplete(context, "repo-1", focusedValue, deps)) as unknown as {
    data: { choices: { name: string; value: string }[] };
  };
  return res.data.choices;
};

const numbersFor = async (focusedValue: string, items?: CachedPullRequest[]): Promise<string[]> =>
  (await choicesFor(focusedValue, items)).map((choice) => choice.value);

describe("handlePrAutocomplete の絞り込み", () => {
  it("空クエリなら全件を返す", async () => {
    expect(await numbersFor("")).toEqual(["1", "2", "3", "123"]);
  });

  it("PR 番号で絞り込める", async () => {
    expect(await numbersFor("123")).toEqual(["123"]);
  });

  it("title で絞り込める", async () => {
    expect(await numbersFor("login")).toEqual(["1"]);
  });

  it("author login で絞り込める", async () => {
    expect(await numbersFor("alice")).toEqual(["1", "3"]);
  });

  it("大文字小文字を区別しない", async () => {
    expect(await numbersFor("FEAT")).toEqual(["1"]);
  });

  it("最大 25 件に制限される", async () => {
    const manyPrs = Array.from({ length: 30 }, (_, i) => makePr(i + 1, `feat: pr ${String(i + 1)}`, "user"));
    expect(await numbersFor("", manyPrs)).toHaveLength(25);
  });

  it("番号を含む複数 PR がある場合、部分一致では複数返す", async () => {
    const numberedPrs = [
      makePr(5, "feat: five", "alice"),
      makePr(15, "feat: fifteen", "bob"),
      makePr(50, "feat: fifty", "carol"),
    ];
    expect(await numbersFor("5", numberedPrs)).toEqual(["5", "15", "50"]);
  });

  it("候補名は PR 番号と title を並べ、100 文字に収める", async () => {
    const choices = await choicesFor("", [makePr(123, "feat: test", "user"), makePr(124, "a".repeat(100), "user")]);
    expect(choices.at(0)?.name).toBe("#123 feat: test");
    expect(choices.at(1)?.name).toHaveLength(100);
  });
});

describe("handlePrAutocomplete の URL 入力", () => {
  const numberedPrs = [
    makePr(5, "feat: five", "alice"),
    makePr(15, "feat: fifteen", "bob"),
    makePr(50, "feat: fifty", "carol"),
  ];

  it("PR URL では番号が完全一致する PR だけを返す", async () => {
    expect(await numbersFor("https://github.com/org/repo/pull/5", numberedPrs)).toEqual(["5"]);
  });

  it("PR URL の番号に一致する PR がなければ空を返す", async () => {
    expect(await numbersFor("https://github.com/org/repo/pull/5", numberedPrs.slice(1))).toEqual([]);
  });

  it("PR URL の owner と repository 名は大文字小文字を区別せずに照合する", async () => {
    expect(await numbersFor("https://github.com/Org/Repo/pull/5", numberedPrs)).toEqual(["5"]);
  });

  it("repository URL の owner と repository 名は大文字小文字を区別せずに照合し、全件を返す", async () => {
    expect(await numbersFor("https://github.com/ORG/REPO", numberedPrs)).toEqual(["5", "15", "50"]);
  });

  it("別の repository の URL では空候補を返す", async () => {
    expect(await numbersFor("https://github.com/org/other/pull/5", numberedPrs)).toEqual([]);
    expect(await numbersFor("https://github.com/other/repo", numberedPrs)).toEqual([]);
  });

  it("URL でない入力はそのまま部分一致の query にする", async () => {
    expect(await numbersFor("fix")).toEqual(["2"]);
  });
});
