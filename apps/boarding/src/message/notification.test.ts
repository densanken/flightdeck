import { describe, expect, it } from "vitest";

import { mergedNotification, openedNotification } from "./notification.js";

describe("登録通知の文面", () => {
  it.each([
    [{ status: "allowed", reason: "AUTHORIZED" }, 0x2ea44f],
    [{ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, 0x2ea44f],
    [{ status: "waiting", reason: "EVALUATING" }, 0xe3b341],
    [{ status: "rejected", reason: "INVALID_PROFILE" }, 0xcf222e],
    [{ status: "error", reason: "API_ERROR" }, 0xcf222e],
  ] as const)("申請の状態に応じた embed を送る", (result, color) => {
    const payload = openedNotification({ number: 1, author: "alice", roots: [], result });
    expect(payload.embeds[0]).toMatchObject({ title: "著者登録申請", color });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("完了の embed を成功色とメンション無効で送る", () => {
    const payload = mergedNotification({ number: 1, roots: [] });
    expect(payload.embeds[0]).toMatchObject({ title: "著者登録完了", color: 0x2ea44f });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("申請の認可状態を読める文言で表示する", () => {
    const notification = openedNotification({
      number: 1,
      author: "alice",
      roots: [{ name: "alice", editors: null }],
      result: {
        status: "rejected",
        reason: "INITIAL_AUTHOR_NOT_EDITOR",
        facts: { authorRoots: ["alice"], otherPaths: ["README.md"], invalidCommits: [] },
      },
    });
    const text = notification.embeds.flatMap((embed) => embed.fields.map((field) => field.value)).join("\n");
    expect(notification.embeds[0]?.fields.find((field) => field.name === "著者以外の変更")?.value).toBe("あり");
    expect(text).toContain("認可されませんでした");
    expect(text).toContain("PR 作成者が Editor に含まれていない");
    expect(text).toContain("確認できません");
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
    })
      .embeds.flatMap((embed) => embed.fields.map((field) => field.value))
      .join("\n");
    expect(text).toContain("authors 以外の変更を含む");
  });

  it("利用者の入力に含まれる Markdown の記号をエスケープする", () => {
    const text = openedNotification({
      number: 1,
      author: "**alice**",
      roots: [{ name: "||alice||", editors: [{ type: "team", slug: "**team**" }] }],
      result: { status: "allowed", reason: "AUTHORIZED" },
    })
      .embeds.flatMap((embed) => embed.fields.map((field) => field.value))
      .join("\n");
    expect(text).toContain("\\*\\*alice\\*\\*");
    expect(text).toContain("\\|\\|alice\\|\\|");
    expect(text).toContain("team:\\*\\*team\\*\\*");
  });

  it("著者ごとに Editor を 1 行にまとめる", () => {
    const payload = mergedNotification({
      number: 1,
      roots: [
        {
          name: "alice",
          editors: [
            { type: "user", login: "bob" },
            { type: "user", login: "carol" },
          ],
        },
        { name: "dave", editors: [] },
        { name: "eve", editors: null },
      ],
    });
    expect(payload.embeds[0]?.fields.find((field) => field.name === "AuthorRoot / Editor")?.value).toBe(
      "- alice: bob, carol\n- dave: なし\n- eve: 確認できません"
    );
  });

  it("全文が上限内なら長い著者名も省略しない", () => {
    const name = "a".repeat(1000);
    const value = mergedNotification({
      number: 1,
      roots: [
        { name, editors: [] },
        { name: "bob", editors: [] },
      ],
    }).embeds[0]?.fields[1]?.value;
    expect(value).toBe(`- ${name}: なし\n- bob: なし`);
  });

  it("複数の著者で最初の Editor が多い場合も著者名を残す", () => {
    const editors = Array.from({ length: 200 }, (_, index) => ({
      type: "user" as const,
      login: `editor-${String(index)}`,
    }));
    const value = mergedNotification({
      number: 1,
      roots: [
        { name: "alice", editors },
        { name: "bob", editors: [] },
      ],
    }).embeds[0]?.fields[1]?.value;
    expect(value).toContain("- alice: editor\\-0");
    expect(value).toContain("- bob: なし");
    expect(value).toContain("editor\\-70");
    expect(value).toContain("…ほか");
    expect(value?.length).toBeLessThanOrEqual(1024);
  });

  it("多数の Editor を含む通知は省略して長さを抑える", () => {
    const editors = Array.from({ length: 200 }, (_, index) => ({
      type: "user" as const,
      login: `editor-${String(index)}`,
    }));
    const text = mergedNotification({ number: 1, roots: [{ name: "alice", editors }] }).embeds[0];
    expect(text?.fields[1]?.value.length).toBeLessThanOrEqual(1024);
    expect(text?.fields[1]?.value).toContain("- alice: editor\\-0");
    expect(text?.fields[1]?.value).toMatch(/…ほか \d+ 件/);
    expect(text?.url).toContain("https://github.com/densanken/blog-contents/pull/1");
  });
});
