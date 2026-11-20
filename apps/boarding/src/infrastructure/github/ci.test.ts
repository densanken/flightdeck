import { describe, expect, it } from "vitest";

import { readCi } from "./ci.js";

const check = {
  __typename: "CheckRun",
  name: "ci",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  checkSuite: { app: { databaseId: 2, slug: "github-actions" } },
};

describe("CI の取得結果", () => {
  it("Check と Status を判定に使う形式に変換する", () => {
    const contexts = {
      totalCount: 2,
      nodes: [check, { __typename: "StatusContext", context: "lint", state: "EXPECTED" }],
    };
    expect(readCi({ contexts })).toEqual({
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 2, slug: "github-actions" } }],
      statuses: [{ context: "lint", state: "pending" }],
    });
  });

  it("rollup がなければ空の CI を返す", () => {
    expect(readCi(null)).toEqual({ checks: [], statuses: [] });
  });

  it.each([
    { contexts: { totalCount: 2, nodes: [check] } },
    { contexts: { totalCount: 1, nodes: [{ __typename: "Other" }] } },
    { contexts: { totalCount: 1, nodes: [null] } },
  ])("取得が不完全なら判定できない状態にする", (rollup) => {
    expect(readCi(rollup)).toBeNull();
  });
});
