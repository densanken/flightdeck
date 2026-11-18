import { describe, expect, it } from "vitest";

import { approvalRepositoryId, approvalRuns, isContentOnlyAllowed } from "./workflow.js";

const run = {
  id: 1,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  headSha: "sha",
  headRepositoryId: 2,
  status: "completed",
  conclusion: "action_required",
  actorId: 3,
};
const input = { headSha: "sha", headRepositoryId: 2, authorId: 3 };

describe("Workflow Run の承認", () => {
  it.each([
    { path: ".github/workflows/other.yml" },
    { event: "push" },
    { headSha: "old" },
    { headRepositoryId: 4 },
    { status: "queued" },
    { status: "action_required" },
    { conclusion: "success" },
    { conclusion: null },
    { actorId: 4 },
  ])("条件が異なる Run を除外する: %o", (change) => {
    expect(approvalRuns([{ ...run, ...change }], input)).toEqual([]);
  });

  it("すべて一致する Run を選ぶ", () => {
    expect(approvalRuns([run], input)).toEqual([run]);
  });

  it.each([
    [{ status: "allowed", facts: { otherPaths: [] } }, true],
    [{ status: "waiting", facts: { otherPaths: [] } }, false],
    [{ status: "allowed", facts: { otherPaths: ["x"] } }, false],
    [{ status: "allowed", facts: undefined }, false],
  ] as const)("著者コンテンツのみの認可を判定する: %o", (result, expected) => {
    expect(isContentOnlyAllowed(result)).toBe(expected);
  });

  it.each([
    [true, 2, 2],
    [false, 2, null],
    [true, null, null],
  ] as const)("Fork の head repository を判定する: %s %s", (crossRepository, headRepositoryId, expected) => {
    expect(
      approvalRepositoryId({
        crossRepository,
        headRepositoryId,
        result: { status: "allowed", facts: { otherPaths: [] } },
      })
    ).toBe(expected);
  });
});
