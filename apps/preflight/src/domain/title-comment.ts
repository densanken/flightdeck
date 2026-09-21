import { ALLOWED_PR_TITLE_TYPES, CONVENTIONAL_COMMITS_URL } from "@flightdeck/pr-title";

import type { TitleValidationFailure } from "@flightdeck/pr-title";

export const PR_TITLE_COMMENT_MARKER = "<!-- preflight:pr-title-validation -->";

// scope を囲む `()` は省略できない
// 公式表記の `[optional scope]` は角括弧が省略可能を表すが、
// 読んだ人が `feat[api]:` と書きかねないため、書く文字がそのまま出る表記にする
const TITLE_FORMAT = "`<type>(<optional scope>)<optional !>: <description>`";
const TYPE_LIST = ALLOWED_PR_TITLE_TYPES.map((type) => `\`${type}\``).join(", ");
const DESCRIPTION_END_CHARACTERS = "`.` `,` `;` `:` `!` `?`";
// 全角記号は該当する文字が多いため、日本語入力から混入しやすい代表例だけを挙げる
const FULLWIDTH_SYMBOL_EXAMPLES =
  "`、` `。` `，` `．` `：` `；` `！` `？` `（` `）` `「` `」` `【` `】` `〜` `・` `…` `※`";
const FULLWIDTH_SYMBOL_RULES = [
  "全角と CJK の記号は、末尾だけでなくタイトルのどこにも使用できません",
  `${FULLWIDTH_SYMBOL_EXAMPLES} のような記号はいずれも使用できません`,
] as const;

const longestRun = (value: string, character: "`" | "~"): number => {
  let longest = 0;
  let current = 0;
  for (const valueCharacter of value) {
    if (valueCharacter === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
};

export const createSafeMarkdownCodeFence = (value: string): string => {
  const fenceLength = Math.max(3, longestRun(value, "`") + 1, longestRun(value, "~") + 1);
  const fence = "~".repeat(fenceLength);
  return `${fence}text\n${value}\n${fence}`;
};

const bulletList = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");
const codeBulletList = (items: readonly string[]): string => items.map((item) => `- \`${item}\``).join("\n");

/**
 * ルールを毎回すべて並べると、無関係な行の中から自分の問題を探すことになるため
 * 失敗理由ごとに、原因に関係するルールと修正例だけを出す
 */
interface TitleFailureGuidance {
  summary: string;
  rules: readonly string[];
  examples: readonly string[];
}

const STANDARD_EXAMPLES = ["feat: add passkey login", "feat: ログイン機能を追加"];

const failureGuidance = (result: TitleValidationFailure): TitleFailureGuidance => {
  switch (result.reason) {
    case "empty":
      return {
        summary: "タイトルが空です。",
        rules: [`タイトルは ${TITLE_FORMAT} の形式で書く必要があります。`],
        examples: STANDARD_EXAMPLES,
      };
    case "surrounding_whitespace":
      return {
        summary: "タイトルの先頭または末尾に空白があります。",
        rules: ["タイトルの先頭と末尾に空白を置くことはできません"],
        examples: [],
      };
    case "invalid_format":
      return {
        summary: `${TITLE_FORMAT} の形式に一致しません。`,
        rules: [
          "type と description の区切りは `:` と半角スペース 1 個にする必要があります",
          "破壊的変更の `!` は `:` の直前に置く必要があります",
          "制御文字と不可視文字（zero-width space, NBSP など）は使用できません",
        ],
        examples: ["feat: add passkey login", "feat(api)!: change response format"],
      };
    case "fullwidth_symbol":
      return {
        summary: "タイトルに全角の記号が含まれています。",
        // 全角記号は形式や type より先に判定するため、取り除いたあとで別の失敗になることがある
        rules: [...FULLWIDTH_SYMBOL_RULES],
        examples: ["feat: 認証まわりを整理", "feat: 対応 (暫定) を追加"],
      };
    case "unsupported_type":
      return {
        summary: "使用できる type ではありません。",
        rules: [`使用できる type は ${TYPE_LIST} で、すべて英小文字とする必要があります`],
        examples: ["feat: add passkey login", "chore(deps): update hono"],
      };
    case "invalid_scope":
      return {
        summary: "scope がルールに一致しません。",
        rules: [
          "scope に使用できる文字は英小文字、数字、`-` `.` `_` `/` に限られます",
          "scope の先頭と末尾は英小文字か数字とする必要があります",
          "scope で利用する `/` は 1 つまでとする必要があります",
          "scope の省略も可能です",
        ],
        examples: ["fix(auth): reject expired sessions", "chore(deps): update hono"],
      };
    case "invalid_description":
      return {
        summary: "description の先頭または末尾がルールに一致しません。",
        rules: [
          "**`:` の後の半角スペースが 2 個以上ある場合、description が空白で始まるためこのエラーが出ることがあります**",
          "description の先頭は英小文字、数字、漢字、ひらがな、カタカナのいずれかとする必要があります",
          "description の先頭を大文字、記号、絵文字で始めることはできません",
          `description の末尾に ${DESCRIPTION_END_CHARACTERS} は使用できません`,
        ],
        examples: ["feat: api 連携を追加", "feat: 新しい API を追加"],
      };
  }
};

/**
 * 折りたたんだ全ルール
 * このリポジトリのルールは Conventional Commits の上位互換ではないため、
 * 公式へのリンクだけを置いて「公式に従えば通る」と誤解されることを防ぐ
 */
const ALL_RULES_DETAILS = `<details>
<summary>タイトルのルール</summary>

${TITLE_FORMAT}

書式は [Conventional Commits](${CONVENTIONAL_COMMITS_URL}) に沿う必要があります。
そのうえで、type の一覧、scope の文字種、description の先頭と末尾、タイトル全体の全角記号などをより厳しく検証します。
そのため、上記サイトに従って書いたタイトルであっても、次の点で無効になることがあります。

${bulletList([
  `使用できる type は ${TYPE_LIST} で、すべて英小文字とする必要があります`,
  "type と description の区切りは `:` と半角スペース 1 個にする必要があります",
  "scope は省略可能です",
  "scope に使用できる文字は英小文字、数字、`-` `.` `_` `/` に限られます",
  "scope の先頭と末尾は英小文字か数字とする必要があります",
  "scope で利用する `/` は 1 つまでとする必要があります",
  "破壊的変更の `!` は `:` の直前に置く必要があります",
  "description の先頭は**英小文字**、数字、漢字、ひらがな、カタカナのいずれかとする必要があります",
  `description の末尾に ${DESCRIPTION_END_CHARACTERS} は使用できません`,
  ...FULLWIDTH_SYMBOL_RULES,
  "タイトルの先頭と末尾に空白がないことを確認してください",
  "制御文字と不可視文字（zero-width space, NBSP など）は使用できません",
])}

</details>`;

const failureDetail = (result: TitleValidationFailure): string => {
  const guidance = failureGuidance(result);
  const examples = guidance.examples.length === 0 ? "" : `### 修正例\n\n${codeBulletList(guidance.examples)}`;
  return `> [!WARNING]
> ${guidance.summary}

### 現在のタイトル

${createSafeMarkdownCodeFence(result.title)}

### 該当するルール

${bulletList(guidance.rules)}

${examples}

${ALL_RULES_DETAILS}`;
};

export const buildTitleValidationFailureComment = (
  result: TitleValidationFailure
): string => `${PR_TITLE_COMMENT_MARKER}

## Pull Request のタイトルを修正してください

${failureDetail(result)}

タイトルを編集すると再検証され、ルールに一致すればこのコメントは削除されます。
`;

export const buildDraftTitleComment = (result: TitleValidationFailure): string => `${PR_TITLE_COMMENT_MARKER}

## Ready for review の前にタイトルを修正してください

この Pull Request の現在のタイトルはルールに一致していないため、Ready for review にする前に修正してください。

${failureDetail(result)}

タイトルを編集すると再検証され、ルールに一致すればこのコメントは削除されます。
`;

export const buildDraftMarkerTitleComment = (title: string): string => `${PR_TITLE_COMMENT_MARKER}

## この Pull Request はまだ作業中です

タイトルの先頭に \`[WIP]\`, \`WIP:\`, \`[draft]\`, \`draft:\` のいずれかが付いているため、
この Pull Request タイトルの検証を保留しています。

接頭辞が付いている間、\`PR Title\` status は \`success\` になりません。

### 現在のタイトル

${createSafeMarkdownCodeFence(title)}

接頭辞を外すとタイトルの検証を行い、タイトルがルールに一致すればこのコメントは削除されます。

${ALL_RULES_DETAILS}
`;
