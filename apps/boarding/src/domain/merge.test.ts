import { describe, expect, it } from "vitest";

import { decideMerge, hasPendingCi } from "./merge.js";

import type { MergeDecision } from "./merge.js";

const body = "- [x] すべてのチェックが成功したら自動マージする";
const data = {
  body,
  draft: false,
  ci: {
    checks: [{ name: "test", status: "completed", conclusion: "success", app: { id: 9, slug: "github-actions" } }],
    statuses: [],
  },
};
const input = {
  data,
  versions: [{ body, editorId: 1 }],
  authorId: 1,
  allowed: true,
  authorRoots: ["alice"],
  otherPaths: [],
  approved: true,
  appId: 10,
};

describe("Merge の判定", () => {
  it("すべての条件が成立すれば待機しない", () => {
    expect(decideMerge(input)).toEqual({ request: "accepted", waiting: undefined });
  });

  it.each([
    [{ draft: true }, "DRAFT"],
    [{ ci: null }, "CI_UNAVAILABLE"],
    [{ ci: { checks: [], statuses: [] } }, "CI_PENDING"],
    [
      {
        ci: {
          checks: [
            { name: "test", status: "completed", conclusion: "failure", app: { id: 9, slug: "github-actions" } },
          ],
          statuses: [],
        },
      },
      "CI_FAILED",
    ],
  ])("条件が満たされなければ待機する", (change, waiting) => {
    expect(decideMerge({ ...input, data: { ...data, ...change } })).toEqual({ request: "accepted", waiting });
  });

  it.each([
    [{ allowed: false }, "AUTHORIZATION"],
    [{ approved: false }, "APP_APPROVAL"],
  ])("認可と Approve の不足を判定する", (change, waiting) => {
    expect(decideMerge({ ...input, ...change })).toEqual({ request: "accepted", waiting });
  });

  it.each([
    [true, [], []],
    [true, [], ["README.md"]],
    [true, ["alice"], ["README.md"]],
    [false, [], []],
    [false, [], ["README.md"]],
    [false, ["alice"], ["README.md"]],
  ])("認可が %s で対象パスの条件を満たさない場合は待機する", (allowed, authorRoots, otherPaths) => {
    expect(decideMerge({ ...input, allowed, authorRoots, otherPaths })).toEqual({
      request: "accepted",
      waiting: "AUTHORS_ONLY",
    });
  });

  it.each<[string, number, MergeDecision]>([
    ["- [ ] すべてのチェックが成功したら自動マージする", 1, { request: "none" }],
    [`${body}\n${body}`, 1, { request: "invalid", reason: "INVALID_CHECKBOX" }],
    [body, 2, { request: "invalid", reason: "NOT_AUTHOR" }],
  ])("本文と編集者から依頼を判定する", (currentBody, editorId, expected) => {
    expect(
      decideMerge({ ...input, data: { ...data, body: currentBody }, versions: [{ body: currentBody, editorId }] })
    ).toEqual(expected);
  });

  it("自分の実行中 Check を除き Actions の結果を判定する", () => {
    const checks = [
      ...data.ci.checks,
      { name: "boarding/authorization", status: "in_progress", conclusion: null, app: { id: 10, slug: "boarding" } },
    ];
    expect(decideMerge({ ...input, data: { ...data, ci: { ...data.ci, checks } } })).toEqual({
      request: "accepted",
      waiting: undefined,
    });
  });

  it("編集履歴を確認できなければ無効にする", () => {
    expect(decideMerge({ ...input, versions: null })).toEqual({
      request: "invalid",
      reason: "HISTORY_UNAVAILABLE",
    });
  });
});

describe("CI の未完了判定", () => {
  it.each([
    [
      "未完了",
      {
        checks: [{ name: "ci", status: "in_progress", conclusion: null, app: { id: 2, slug: "github-actions" } }],
        statuses: [],
      },
      true,
    ],
    [
      "成功",
      {
        checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 2, slug: "github-actions" } }],
        statuses: [],
      },
      false,
    ],
    [
      "失敗",
      {
        checks: [{ name: "ci", status: "completed", conclusion: "failure", app: { id: 2, slug: "github-actions" } }],
        statuses: [],
      },
      false,
    ],
    [
      "失敗と実行中が混在",
      {
        checks: [
          { name: "ci", status: "completed", conclusion: "failure", app: { id: 2, slug: "github-actions" } },
          { name: "other", status: "in_progress", conclusion: null, app: { id: 2, slug: "github-actions" } },
        ],
        statuses: [],
      },
      true,
    ],
    [
      "Status が未完了",
      {
        checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 2, slug: "github-actions" } }],
        statuses: [{ context: "external", state: "pending" }],
      },
      true,
    ],
    [
      "自分の Check が実行中",
      {
        checks: [
          { name: "ci", status: "completed", conclusion: "success", app: { id: 2, slug: "github-actions" } },
          {
            name: "boarding/authorization",
            status: "in_progress",
            conclusion: null,
            app: { id: 20, slug: "boarding" },
          },
        ],
        statuses: [],
      },
      false,
    ],
    [
      "他の App の同名 Check が実行中",
      {
        checks: [
          { name: "ci", status: "completed", conclusion: "success", app: { id: 2, slug: "github-actions" } },
          { name: "boarding/authorization", status: "in_progress", conclusion: null, app: { id: 21, slug: "other" } },
        ],
        statuses: [],
      },
      true,
    ],
    ["取得不完全", null, false],
    ["Check がない", { checks: [], statuses: [] }, false],
    ["Status だけ成功", { checks: [], statuses: [{ context: "external", state: "success" }] }, false],
  ])("CI が%sなら未完了か判定する", (_label, ci, expected) => {
    expect(hasPendingCi(ci, 20)).toBe(expected);
  });
});
