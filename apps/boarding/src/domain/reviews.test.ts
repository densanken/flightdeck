import { describe, expect, it } from "vitest";

import { approvedPeople, approvedReviewers } from "./reviews.js";

import type { Review } from "./reviews.js";

const review = (overrides: Partial<Review>): Review => ({
  reviewerId: 2,
  state: "APPROVED",
  commitSha: "head",
  submittedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("approvedReviewers", () => {
  it("承認後の COMMENTED は承認を取り消さない", () => {
    expect(
      approvedReviewers([review({}), review({ state: "COMMENTED", submittedAt: "2026-01-02T00:00:00Z" })], "head", 1)
    ).toEqual([2]);
  });

  it("変更要求後の COMMENTED は変更要求を取り消さない", () => {
    expect(
      approvedReviewers(
        [
          review({}),
          review({ state: "CHANGES_REQUESTED", submittedAt: "2026-01-02T00:00:00Z" }),
          review({ state: "COMMENTED", submittedAt: "2026-01-03T00:00:00Z" }),
        ],
        "head",
        1
      )
    ).toEqual([]);
  });

  it("日時の表記が異なっても新しい Review を優先する", () => {
    expect(
      approvedReviewers(
        [review({}), review({ state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00.500Z" })],
        "head",
        1
      )
    ).toEqual([]);
  });

  it("日時を判定できない Reviewer の承認を数えない", () => {
    expect(approvedReviewers([review({}), review({ submittedAt: "invalid" })], "head", 1)).toEqual([]);
  });

  it("同時刻の Review があるときは承認を数えない", () => {
    expect(approvedReviewers([review({}), review({ state: "CHANGES_REQUESTED" })], "head", 1)).toEqual([]);
  });

  it("最新 HEAD の最新 Review だけを数える", () => {
    expect(
      approvedReviewers(
        [
          review({ reviewerId: 2 }),
          review({ reviewerId: 2, state: "DISMISSED", submittedAt: "2026-01-02T00:00:00Z" }),
          review({ reviewerId: 3, commitSha: "old" }),
          review({ reviewerId: 4 }),
          review({ reviewerId: 1 }),
        ],
        "head",
        1
      )
    ).toEqual([4]);
  });
});

describe("有効な Reviewer", () => {
  it("作成者と Bot を除き ID ごとに一度だけ返す", () => {
    const reviews = [
      { ...review({ reviewerId: 1 }), login: "author" },
      { ...review({ reviewerId: 2 }), login: "alice" },
      { ...review({ reviewerId: 3 }), login: "bot", isBot: true },
      { ...review({ reviewerId: 2, state: "COMMENTED" }), login: "alice" },
    ];
    expect(approvedPeople(reviews, "head", 1)).toEqual([{ id: 2, login: "alice" }]);
  });
});
