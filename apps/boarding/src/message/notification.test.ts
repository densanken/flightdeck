import { describe, expect, it } from "vitest";

import { mergedNotification, openedNotification } from "./notification.js";

import type { DiscordPayload } from "./notification.js";

const container = (payload: DiscordPayload): DiscordPayload["components"][0] => {
  const [first] = payload.components;
  if (!first) throw new Error("container がありません");
  return first;
};

const texts = (payload: DiscordPayload): string[] =>
  container(payload).components.flatMap((component) => (component.type === 10 ? [component.content] : []));

describe("登録通知の文面", () => {
  it.each([
    { status: "allowed", reason: "AUTHORIZED" },
    { status: "not_applicable", reason: "NO_CONTENT_CHANGES" },
    { status: "waiting", reason: "EVALUATING" },
    { status: "rejected", reason: "INVALID_PROFILE" },
    { status: "error", reason: "API_ERROR" },
  ] as const)("申請の通知は状態にかかわらず中立な色の Components V2 で送る", (result) => {
    const payload = openedNotification({ number: 1, author: "alice", roots: [], result });
    expect(payload.flags).toBe(1 << 15);
    expect(container(payload)).toMatchObject({ type: 17, accent_color: 0x5865f2 });
    expect(texts(payload)[0]).toContain("## 執筆者の登録申請");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("embeds");
  });

  it("Text Display を区切り線で分けて並べる", () => {
    const { components } = container(
      openedNotification({
        number: 1,
        author: "alice",
        roots: [],
        result: { status: "allowed", reason: "AUTHORIZED" },
      })
    );
    expect(components.map((component) => component.type)).toEqual([10, 14, 10, 14, 10, 14, 10]);
  });

  it("PR 番号に PR へのリンクを付ける", () => {
    const payload = mergedNotification({ number: 24, roots: [] });
    expect(texts(payload)).toContain("**PR**\n[#24](https://github.com/densanken/blog-contents/pull/24)");
  });

  it("申請の通知は PR を左に、PR Author を右に 1 行で並べる", () => {
    const payload = openedNotification({
      number: 24,
      author: "alice",
      roots: [],
      result: { status: "allowed", reason: "AUTHORIZED" },
    });
    expect(texts(payload)[1]).toMatch(/^\*\*PR\*\* \[#24\]\(\S+\/pull\/24\) · \*\*PR Author\*\* `alice`$/);
  });

  it("完了の通知を成功色とメンション無効で送る", () => {
    const payload = mergedNotification({ number: 1, roots: [] });
    expect(payload.flags).toBe(1 << 15);
    expect(container(payload).accent_color).toBe(0x2ea44f);
    expect(texts(payload)[0]).toBe("## 執筆者の登録完了");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("申請の認可状態を読める文言で表示する", () => {
    const text = texts(
      openedNotification({
        number: 1,
        author: "alice",
        roots: [{ name: "alice", editors: null }],
        result: {
          status: "rejected",
          reason: "INITIAL_AUTHOR_NOT_EDITOR",
          facts: { authorRoots: ["alice"], otherPaths: ["README.md"], invalidCommits: [] },
        },
      })
    ).join("\n");
    expect(text).toContain("**`authors/` 以外の変更**\nあり");
    expect(text).toContain("マージできません（PR 作成者が editors に含まれていません）");
    expect(text).toContain("確認できません");
    expect(text).not.toContain("INITIAL_AUTHOR_NOT_EDITOR");
  });

  it("認可済みの申請に他の人の Approve を前提にした文言を使わない", () => {
    const text = texts(
      openedNotification({
        number: 1,
        author: "alice",
        roots: [],
        result: { status: "allowed", reason: "AUTHORIZED" },
      })
    ).join("\n");
    expect(text).toContain("authors/ の変更に問題はありません");
    expect(text).not.toContain("Approve がそろいました");
    expect(text.replaceAll(/github\.com\/\S+/g, "")).not.toContain("boarding");
  });

  it("authors/ 以外の変更を案内文ではなく短い状態で示す", () => {
    const text = texts(
      openedNotification({
        number: 1,
        author: "alice",
        roots: [],
        result: {
          status: "rejected",
          reason: "NON_CONTENT_CHANGE_FORBIDDEN",
          facts: { authorRoots: [], otherPaths: ["README.md"], invalidCommits: [] },
        },
      })
    ).join("\n");
    expect(text).toContain("authors/ 以外の変更が含まれています");
  });

  it("利用者の入力をコードの書式で囲み Markdown として解釈させない", () => {
    const text = texts(
      openedNotification({
        number: 1,
        author: "**alice**",
        roots: [{ name: "||alice||", editors: [{ type: "team", slug: "**team**" }] }],
        result: { status: "allowed", reason: "AUTHORIZED" },
      })
    ).join("\n");
    expect(text).toContain("**PR Author** `**alice**`");
    expect(text).toContain("- `authors/||alice||/`: `team:**team**`");
  });

  it("ディレクトリごとに Editor を 1 行にまとめる", () => {
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
    expect(texts(payload)).toContain(
      "**ディレクトリと Editor**\n- `authors/alice/`: `bob`, `carol`\n- `authors/dave/`: なし\n- `authors/eve/`: 確認できません"
    );
  });

  it("全文が上限内なら長いディレクトリ名も省略しない", () => {
    const name = "a".repeat(2_000);
    const payload = mergedNotification({
      number: 1,
      roots: [
        { name, editors: [] },
        { name: "bob", editors: [] },
      ],
    });
    expect(texts(payload)[2]).toBe(`**ディレクトリと Editor**\n- \`authors/${name}/\`: なし\n- \`authors/bob/\`: なし`);
  });

  it("複数のディレクトリで最初の Editor が多い場合もディレクトリ名を残す", () => {
    const editors = Array.from({ length: 400 }, (_, index) => ({
      type: "user" as const,
      login: `editor-${String(index)}`,
    }));
    const value = texts(
      mergedNotification({
        number: 1,
        roots: [
          { name: "alice", editors },
          { name: "bob", editors: [] },
        ],
      })
    )[2];
    expect(value).toContain("- `authors/alice/`: `editor-0`");
    expect(value).toContain("- `authors/bob/`: なし");
    expect(value).toContain("…ほか");
  });

  it("多数の Editor を含む通知も Text Display の合計を 4000 文字以内に省略する", () => {
    const editors = Array.from({ length: 400 }, (_, index) => ({
      type: "user" as const,
      login: `editor-${String(index)}`,
    }));
    const roots = Array.from({ length: 20 }, (_, index) => ({ name: `author-${String(index)}`, editors }));
    const payload = openedNotification({
      number: 1,
      author: "a".repeat(200),
      roots,
      result: { status: "waiting", reason: "EDITOR_APPROVAL_MISSING" },
    });
    expect(texts(payload).join("").length).toBeLessThanOrEqual(4_000);
    expect(texts(payload)[2]).toMatch(/…ほか \d+ 件/);
  });
});
