import { describe, expect, it } from "vitest";

import { timelineItem } from "./timeline.js";

describe("timeline の型", () => {
  it.each(["HeadRefDeletedEvent", "HeadRefRestoredEvent"])("%s をイベントに変換する", (type) => {
    const createdAt = "2026-11-01T00:00:00Z";

    const result = timelineItem({
      __typename: type,
      createdAt,
      actor: { __typename: "User", databaseId: 1 },
    });

    expect(result).toMatchObject({ kind: "event", createdAt, actor: { type: "User", id: 1 } });
  });

  it.each(["AutoMergeEnabledEvent", "AutoMergeDisabledEvent"])("%s の操作時刻と actor を変換する", (type) => {
    const createdAt = "2026-11-09T00:00:00Z";
    expect(timelineItem({ __typename: type, createdAt, actor: { __typename: "User", databaseId: 7 } })).toEqual({
      kind: "event",
      createdAt,
      actor: { type: "User", id: 7, login: undefined },
    });
    expect(timelineItem({ __typename: type, createdAt, actor: { __typename: "Bot", databaseId: 2 } })).toEqual({
      kind: "event",
      createdAt,
      actor: { type: "Bot", id: 2, login: undefined },
    });
  });

  it("不正な応答を既知のエラーに変換する", () => {
    expect(() => timelineItem({ __typename: "IssueComment" })).toThrow(
      expect.objectContaining({ code: "invalid_response", errorName: "ZodError" })
    );
  });

  it("指定した actor event だけを数える", () => {
    expect(
      timelineItem({
        __typename: "LabeledEvent",
        createdAt: "2026-01-01Z",
        actor: { __typename: "User", databaseId: 1 },
      })
    ).toMatchObject({ kind: "event", actor: { type: "User", id: 1 } });

    for (const type of ["CrossReferencedEvent", "MentionedEvent", "SubscribedEvent"])
      expect(timelineItem({ __typename: type })).toMatchObject({ kind: "other" });
  });

  it("レビューの作成時刻と submit 時刻を保持する", () => {
    const review = timelineItem({
      __typename: "PullRequestReview",
      createdAt: "2026-01-01T00:00:00Z",
      submittedAt: "2026-11-01T00:00:00Z",
      author: { __typename: "User", databaseId: 1 },
    });

    expect(review).toMatchObject({
      kind: "review",
      createdAt: "2026-01-01T00:00:00Z",
      submittedAt: "2026-11-01T00:00:00Z",
    });
  });
});
