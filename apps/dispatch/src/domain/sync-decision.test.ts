import { describe, expect, it } from "vitest";

import { isUpToDate, planPullRequests } from "./sync-decision.js";

describe("planPullRequests", () => {
  it("意図した base を向く最古の PR を残し、残りを重複とする", () => {
    const plan = planPullRequests(
      [
        { number: 3, baseBranch: "main" },
        { number: 1, baseBranch: "old" },
        { number: 2, baseBranch: "main" },
      ],
      "main"
    );
    expect(plan.keep?.number).toBe(2);
    expect(plan.duplicates.map((pr) => pr.number)).toEqual([1, 3]);
  });

  it("意図した base の PR がなければ最古の PR を残す", () => {
    const plan = planPullRequests(
      [
        { number: 5, baseBranch: "x" },
        { number: 4, baseBranch: "y" },
      ],
      "main"
    );
    expect(plan.keep?.number).toBe(4);
    expect(plan.duplicates.map((pr) => pr.number)).toEqual([5]);
  });

  it("PR がなければ何も残さない", () => {
    expect(planPullRequests([], "main")).toEqual({ keep: undefined, duplicates: [] });
  });
});

describe("isUpToDate", () => {
  const base = {
    baseSha: "B",
    sourceSha: "S",
    expectedMessage: "chore(submodule): update a/b",
    branchCommit: {
      parentShas: ["B"],
      message: "chore(submodule): update a/b",
      gitlinkSha: "S",
      changedFiles: 1 as number | null,
    },
  };

  it("すべて一致すれば true", () => {
    expect(isUpToDate(base)).toBe(true);
  });

  it("変更ファイルの数が不明（null）でも、他が一致すれば true とし、書き換えを繰り返さない", () => {
    expect(isUpToDate({ ...base, branchCommit: { ...base.branchCommit, changedFiles: null } })).toBe(true);
  });

  it.each([
    ["branch がない", { branchCommit: undefined }],
    ["親が古い base", { branchCommit: { ...base.branchCommit, parentShas: ["old"] } }],
    ["親が複数（手動 commit）", { branchCommit: { ...base.branchCommit, parentShas: ["B", "x"] } }],
    ["gitlink が source の SHA でない", { branchCommit: { ...base.branchCommit, gitlinkSha: "old" } }],
    ["gitlink がない", { branchCommit: { ...base.branchCommit, gitlinkSha: undefined } }],
    ["変更ファイルが 2 件以上（手動の変更）", { branchCommit: { ...base.branchCommit, changedFiles: 2 } }],
    ["変更ファイルが 0 件", { branchCommit: { ...base.branchCommit, changedFiles: 0 } }],
    ["message が違う", { branchCommit: { ...base.branchCommit, message: "fix: manual" } }],
  ])("%s なら false", (_name, override) => {
    expect(isUpToDate({ ...base, ...override })).toBe(false);
  });
});
