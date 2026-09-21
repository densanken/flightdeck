import { describe, expect, it } from "vitest";

import { classifyAssignmentNoOp } from "./assignment.js";

import type { AssignmentCandidate } from "./assignment.js";

const candidate = (overrides: Partial<AssignmentCandidate> = {}): AssignmentCandidate => ({
  action: "opened",
  author: "author",
  authorType: "User",
  assignees: [],
  ...overrides,
});

describe("classifyAssignmentNoOp", () => {
  it("skipBots が true のとき大文字の [BOT] suffix を bot とみなす", () => {
    expect(classifyAssignmentNoOp(candidate({ author: "octocat[BOT]" }), true)).toBe("skipped_bot");
  });

  it("skipBots が true のとき author type が Bot なら bot とみなす", () => {
    expect(classifyAssignmentNoOp(candidate({ authorType: "Bot" }), true)).toBe("skipped_bot");
  });

  it("skipBots が false なら bot の作成者を skip しない", () => {
    expect(classifyAssignmentNoOp(candidate({ authorType: "Bot" }), false)).toBeNull();
  });

  it("大文字小文字を無視して assign 済みの作成者を検出する", () => {
    expect(classifyAssignmentNoOp(candidate({ author: "Author", assignees: ["OTHER", "AUTHOR"] }), true)).toBe(
      "already_assigned"
    );
  });

  it("bot でも assign 済みでもない場合は null を返す", () => {
    expect(classifyAssignmentNoOp(candidate({ assignees: ["other"] }), true)).toBeNull();
  });
});
