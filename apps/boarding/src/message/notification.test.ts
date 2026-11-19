import { describe, expect, it } from "vitest";

import { mergedNotification, openedNotification } from "./notification.js";

describe("登録通知の文面", () => {
  it("申請の認可状態を読める文言で表示する", () => {
    const text = openedNotification({
      number: 1,
      author: "alice",
      roots: [{ name: "alice", editors: null }],
      result: {
        status: "rejected",
        reason: "INITIAL_AUTHOR_NOT_EDITOR",
        facts: { authorRoots: ["alice"], otherPaths: ["README.md"], invalidCommits: [] },
      },
    });
    expect(text).toContain("認可されませんでした");
    expect(text).toContain("PR 作成者が Editor に含まれていない");
    expect(text).not.toContain("push してください");
    expect(text).toContain("確認できません");
    expect(text).toContain("著者以外の変更: あり");
    expect(text).not.toContain("INITIAL_AUTHOR_NOT_EDITOR");
  });

  it("著者以外の変更を案内文ではなく短い状態で示す", () => {
    const text = openedNotification({
      number: 1,
      author: "alice",
      roots: [],
      result: {
        status: "rejected",
        reason: "NON_CONTENT_CHANGE_FORBIDDEN",
        facts: { authorRoots: [], otherPaths: ["README.md"], invalidCommits: [] },
      },
    });
    expect(text).toContain("authors 以外の変更を含む");
    expect(text).not.toContain("以下の対象外ファイル");
  });

  it("利用者の入力に含まれる Markdown の記号をエスケープする", () => {
    const text = openedNotification({
      number: 1,
      author: "**alice**",
      roots: [{ name: "||alice||", editors: [{ type: "team", slug: "**team**" }] }],
      result: { status: "allowed", reason: "AUTHORIZED" },
    });
    expect(text).toContain("\\*\\*alice\\*\\*");
    expect(text).toContain("\\|\\|alice\\|\\|");
    expect(text).toContain("team:\\*\\*team\\*\\*");
  });

  it("多数の Editor を含む通知は省略して長さを抑える", () => {
    const editors = Array.from({ length: 200 }, (_, index) => ({
      type: "user" as const,
      login: `editor-${String(index)}`,
    }));
    const text = mergedNotification({ number: 1, roots: [{ name: "alice", editors }] });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("一部省略");
    expect(text).toContain("https://github.com/densanken/blog-contents/pull/1");
  });
});
