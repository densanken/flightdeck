import { describe, expect, it } from "vitest";

import { automergeDisabled, classify, humanActivity, STALE_MS, verifyGitlink, verifySourceHistory } from "./policy.js";

import type { TimelineItem } from "./policy.js";

const now = Date.parse("2026-11-10T00:00:00Z");
const old = new Date(now - 35 * 86400000).toISOString();
const recent = new Date(now - 86400000).toISOString();
const human = { type: "User", id: 42 };
const input = {
  createdAt: old,
  editor: null,
  lastEditedAt: null,
  timeline: [] as TimelineItem[],
  pageCount: 0,
  hasPreviousPage: false,
  recentCount: 0,
  renovateIds: [9],
  now,
};
const dispatch = {
  source: "org/source",
  submoduleUrl: "git@github.com:org/source.git",
  base: { type: "commit", oid: "old" },
  head: { type: "commit", oid: "new" },
  sourceComparison: "BEHIND",
  ancestryComparison: "behind",
};

describe("ポリシー", () => {
  it("人間のレビューは作成が古くても最近 submit されれば操作に数える", () => {
    const review: TimelineItem = { kind: "review", createdAt: old, submittedAt: recent, actor: human };

    expect(humanActivity({ ...input, timeline: [review], pageCount: 1 })).toBe("violated");
    expect(humanActivity({ ...input, timeline: [{ ...review, actor: { type: "Bot", id: 9 } }], pageCount: 1 })).toBe(
      "allowed"
    );
  });

  it("設定した数値 author ID だけを分類する", () => {
    expect(classify(1, 1, [9])).toBe("dispatch");
    expect(classify(9, 1, [9])).toBe("renovate-stale");
    expect(classify(2, 1, [9])).toBeNull();
  });

  it("automerge 無効を示す行が 1 行だけあることを要求する", () => {
    expect(automergeDisabled("🤖 **Automerge**: Disabled by config. extra")).toBe(true);

    for (const text of [
      "",
      "**Automerge**: Enabled.",
      "**Automerge**: Disabled by config.\n**Automerge**: Enabled.",
      "**Automerge**: Disabled by config. **Automerge**: Enabled.",
    ])
      expect(automergeDisabled(text)).toBe(false);
  });

  it("gitlink、source URL、比較の向きを検査する", () => {
    expect(verifyGitlink(dispatch)).toBe(true);
    expect(verifyGitlink({ ...dispatch, base: null })).toBe(false);
    expect(verifyGitlink({ ...dispatch, head: null })).toBe(false);

    for (const update of [{ submoduleUrl: "https://github.com/o/r" }, { base: { type: "blob", oid: "old" } }])
      expect(verifyGitlink({ ...dispatch, ...update })).toBe(false);

    expect(verifySourceHistory("BEHIND", "behind")).toBe("allowed");
    expect(verifySourceHistory("AHEAD", "behind")).toBe("violated");
    expect(verifySourceHistory("BEHIND", "ahead")).toBe("violated");
    expect(verifySourceHistory(null, "behind")).toBe("undeterminable");
  });

  it("30 日で判定し Renovate commit を人間操作に数えない", () => {
    expect(humanActivity(input)).toBe("allowed");
    expect(humanActivity({ ...input, createdAt: new Date(now - STALE_MS + 1).toISOString() })).toBe("violated");
    expect(humanActivity({ ...input, createdAt: new Date(now - STALE_MS).toISOString() })).toBe("allowed");
    expect(humanActivity({ ...input, editor: human, lastEditedAt: recent })).toBe("violated");

    const item: TimelineItem = { kind: "comment", createdAt: old, actor: human, editor: human, lastEditedAt: recent };

    expect(humanActivity({ ...input, timeline: [item], pageCount: 1 })).toBe("violated");

    const commit: TimelineItem = {
      kind: "commit",
      committedAt: recent,
      authorId: null,
      email: "9+renovate@users.noreply.github.com",
    };

    expect(humanActivity({ ...input, timeline: [commit], pageCount: 1 })).toBe("allowed");
    expect(humanActivity({ ...input, timeline: [{ ...commit, email: "unknown@example.com" }], pageCount: 1 })).toBe(
      "violated"
    );
    expect(humanActivity({ ...input, timeline: [item], pageCount: 2 })).toBe("undeterminable");

    const hundred = Array.from({ length: 100 }, (): TimelineItem => ({
      kind: "event",
      createdAt: recent,
      actor: null,
    }));

    expect(
      humanActivity({ ...input, timeline: hundred, pageCount: 100, hasPreviousPage: true, recentCount: 100 })
    ).toBe("violated");
  });
});

describe("timeline の境界", () => {
  it("100 件未満でも未取得があり全件が直近なら違反とする", () => {
    const timeline = Array.from({ length: 98 }, (): TimelineItem => ({ kind: "other" }));

    expect(humanActivity({ ...input, timeline, pageCount: 98, hasPreviousPage: true, recentCount: 98 })).toBe(
      "violated"
    );
    expect(humanActivity({ ...input, timeline, pageCount: 98, hasPreviousPage: true, recentCount: 97 })).toBe(
      "allowed"
    );
    expect(humanActivity({ ...input, timeline, pageCount: 98, hasPreviousPage: false, recentCount: 98 })).toBe(
      "allowed"
    );
  });

  it("commit や対象外 event の境界には直近件数を使う", () => {
    const timeline = Array.from({ length: 100 }, (): TimelineItem => ({ kind: "other" }));

    expect(humanActivity({ ...input, timeline, pageCount: 100, hasPreviousPage: true, recentCount: 100 })).toBe(
      "violated"
    );
    expect(humanActivity({ ...input, timeline, pageCount: 100, hasPreviousPage: true, recentCount: 99 })).toBe(
      "allowed"
    );
    expect(
      humanActivity({
        ...input,
        timeline,
        pageCount: 100,
        hasPreviousPage: true,
        recentCount: 99,
        editor: human,
        lastEditedAt: recent,
      })
    ).toBe("violated");
  });

  it("最近の人間のコメントを数え Renovate の push は数えない", () => {
    const humanComment: TimelineItem = {
      kind: "comment",
      createdAt: recent,
      actor: human,
      editor: null,
      lastEditedAt: null,
    };
    const renovateCommit: TimelineItem = {
      kind: "commit",
      committedAt: recent,
      authorId: 9,
      email: null,
    };
    const earlierHuman: TimelineItem = { kind: "event", createdAt: old, actor: human };

    expect(humanActivity({ ...input, timeline: [humanComment], pageCount: 1 })).toBe("violated");
    expect(humanActivity({ ...input, timeline: [earlierHuman, renovateCommit], pageCount: 2 })).toBe("allowed");
  });

  it("直近 100 件の Renovate commit を拒否し最近の編集を先に数える", () => {
    const timeline = Array.from({ length: 100 }, (): TimelineItem => ({
      kind: "commit",
      committedAt: old,
      authorId: 9,
      email: null,
    }));

    expect(humanActivity({ ...input, timeline, pageCount: 100, hasPreviousPage: true, recentCount: 100 })).toBe(
      "violated"
    );
    expect(
      humanActivity({
        ...input,
        timeline,
        pageCount: 100,
        hasPreviousPage: true,
        recentCount: 99,
        editor: human,
        lastEditedAt: recent,
      })
    ).toBe("violated");
    expect(humanActivity({ ...input, timeline, pageCount: 100, hasPreviousPage: true, recentCount: 99 })).toBe(
      "allowed"
    );
  });

  it("ghost と Bot を無視し最近の人間の commit を拒否する", () => {
    const bot: TimelineItem = { kind: "event", createdAt: recent, actor: { type: "Bot", id: 9 } };
    const ghost: TimelineItem = { kind: "event", createdAt: recent, actor: { type: "User", id: 1, login: "ghost" } };

    expect(humanActivity({ ...input, timeline: [bot, ghost], pageCount: 2 })).toBe("allowed");

    const commit: TimelineItem = { kind: "commit", committedAt: recent, authorId: 42, email: null };

    expect(humanActivity({ ...input, timeline: [commit], pageCount: 1 })).toBe("violated");
  });
});
