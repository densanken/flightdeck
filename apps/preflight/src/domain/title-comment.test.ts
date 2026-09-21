import { validatePullRequestTitle } from "@flightdeck/pr-title";
import { describe, expect, it } from "vitest";

import {
  buildDraftMarkerTitleComment,
  buildDraftTitleComment,
  buildTitleValidationFailureComment,
  createSafeMarkdownCodeFence,
  PR_TITLE_COMMENT_MARKER,
} from "./title-comment.js";

import type { TitleValidationFailure } from "@flightdeck/pr-title";

/** 失敗コメントの生成は失敗した結果だけを受け取るため、検証結果をここで絞り込む */
const invalidTitle = (title: string): TitleValidationFailure => {
  const result = validatePullRequestTitle(title);
  if (result.valid) throw new Error(`invalid なタイトルを前提にしています: ${title}`);
  return result;
};

describe("createSafeMarkdownCodeFence", () => {
  it("信頼できない文字列に含まれる backtick と tilde の連続より長い fence を使う", () => {
    const value = "@octocat [link](https://example.com) <b>html</b> ``` ~~~~";
    expect(createSafeMarkdownCodeFence(value)).toBe(`~~~~~text\n${value}\n~~~~~`);
  });

  it("backtick も tilde も無い文字列には tilde 3 個の fence を使う", () => {
    expect(createSafeMarkdownCodeFence("plain text")).toBe("~~~text\nplain text\n~~~");
  });
});

describe("buildTitleValidationFailureComment", () => {
  it("失敗理由と現在のタイトルを示し、全ルールを折りたたみで添える", () => {
    const comment = buildTitleValidationFailureComment(invalidTitle("feat: Add @octocat."));

    expect(comment).toContain(PR_TITLE_COMMENT_MARKER);
    expect(comment).toContain("## Pull Request のタイトルを修正してください");
    expect(comment).toContain("> description の先頭または末尾がルールに一致しません。");
    expect(comment).toContain("~~~text\nfeat: Add @octocat.\n~~~");
    expect(comment).toContain("<summary>タイトルのルール</summary>");
    expect(comment).toContain("タイトルを編集すると再検証され、ルールに一致すればこのコメントは削除されます。");
    expect(comment).not.toContain("​");
  });

  it("Conventional Commits より厳しい点を折りたたみの中で明示する", () => {
    const comment = buildTitleValidationFailureComment(invalidTitle("feat: Add login"));

    expect(comment).toContain("`<type>(<optional scope>)<optional !>: <description>`");
    expect(comment).toContain("[Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/)");
    expect(comment).toContain(
      "そのうえで、type の一覧、scope の文字種、description の先頭と末尾、タイトル全体の全角記号などをより厳しく検証します。"
    );
  });

  it.each([
    ["", "タイトルが空です。"],
    [" feat: add login", "タイトルの先頭または末尾に空白があります。"],
    ["not conventional", "`<type>(<optional scope>)<optional !>: <description>` の形式に一致しません。"],
    ["Feat: add login", "使用できる type ではありません。"],
    ["feat(BAD): add login", "scope がルールに一致しません。"],
    ["feat: Add login", "description の先頭または末尾がルールに一致しません。"],
    ["feat: add login；", "タイトルに全角の記号が含まれています。"],
  ])("%j の失敗理由を日本語の説明へ対応づける", (title, summary) => {
    expect(buildTitleValidationFailureComment(invalidTitle(title))).toContain(`> ${summary}`);
  });

  it.each([
    ["Feat: add login", "使用できる type は `feat`, `fix`", "scope で利用する `/` は 1 つまでとする必要があります"],
    [
      "feat(BAD): add login",
      "scope の先頭と末尾は英小文字か数字とする必要があります",
      "すべて英小文字とする必要があります",
    ],
    [
      "feat: Add login",
      "description の先頭を大文字、記号、絵文字で始めることはできません",
      "scope で利用する `/` は 1 つまでとする必要があります",
    ],
    [
      "feat: add login；",
      "全角と CJK の記号は、末尾だけでなくタイトルのどこにも使用できません",
      "scope で利用する `/` は 1 つまでとする必要があります",
    ],
  ])("%j には該当するルールだけを出し、無関係なルールは出さない", (title, included, excluded) => {
    const comment = buildTitleValidationFailureComment(invalidTitle(title));
    const [visible] = comment.split("<details>");

    expect(visible).toContain(included);
    expect(visible).not.toContain(excluded);
  });

  it("空白だけが原因のときは修正例を出さない", () => {
    const comment = buildTitleValidationFailureComment(invalidTitle(" feat: add login"));

    expect(comment).toContain("タイトルの先頭と末尾に空白を置くことはできません");
    expect(comment.split("<details>")[0]).not.toContain("修正例");
  });
});

describe("buildDraftTitleComment", () => {
  it("draft 中であることと失敗理由を示し、現在のタイトルを安全に囲む", () => {
    const body = buildDraftTitleComment(invalidTitle("~~~ [WIP] feat: Add login"));

    expect(body.startsWith(PR_TITLE_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("## Ready for review の前にタイトルを修正してください");
    expect(body).toContain("Ready for review にする前に修正してください");
    expect(body).toContain("~~~~text\n~~~ [WIP] feat: Add login\n~~~~");
    expect(body).toContain("> `<type>(<optional scope>)<optional !>: <description>` の形式に一致しません。");
    expect(body).toContain("タイトルを編集すると再検証され、ルールに一致すればこのコメントは削除されます。");
    // 通常の失敗コメントとは別物であること
    expect(body).not.toContain("## Pull Request のタイトルを修正してください");
  });
});

describe("buildDraftMarkerTitleComment", () => {
  it("保留の理由と merge が止まることを示し、現在のタイトルを安全に囲む", () => {
    const body = buildDraftMarkerTitleComment("~~~ [WIP] feat: Add login");

    expect(body.startsWith(PR_TITLE_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("## この Pull Request はまだ作業中です");
    expect(body).toContain("タイトルの先頭に `[WIP]`, `WIP:`, `[draft]`, `draft:` のいずれかが付いているため");
    expect(body).toContain("接頭辞が付いている間、`PR Title` status は `success` になりません。");
    expect(body).toContain("~~~~text\n~~~ [WIP] feat: Add login\n~~~~");
    expect(body).toContain("<summary>タイトルのルール</summary>");
    expect(body).not.toContain("## Pull Request のタイトルを修正してください");
  });
});
