export const CONVENTIONAL_COMMITS_URL = "https://www.conventionalcommits.org/ja/v1.0.0/";

const DRAFT_TITLE_MARKER_PATTERN = /^(?:\[(?:draft|wip)\]|(?:draft|wip):)/i;

/**
 * タイトルの先頭に作業中を示す接頭辞が付いているか
 * `[WIP]`、`WIP:`、`[draft]`、`draft:` を大文字小文字を問わず検出する
 */
export const hasDraftTitleMarker = (title: string): boolean => DRAFT_TITLE_MARKER_PATTERN.test(title.trimStart());

export const ALLOWED_PR_TITLE_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

export type PullRequestTitleType = (typeof ALLOWED_PR_TITLE_TYPES)[number];

export type TitleValidationFailureReason =
  | "empty"
  | "surrounding_whitespace"
  | "invalid_format"
  | "fullwidth_symbol"
  | "unsupported_type"
  | "invalid_scope"
  | "invalid_description";

export interface ParsedPullRequestTitle {
  type: PullRequestTitleType;
  scope: string | undefined;
  breaking: boolean;
  description: string;
}

export type TitleValidationResult =
  | {
      valid: true;
      title: string;
      parsed: ParsedPullRequestTitle;
    }
  | {
      valid: false;
      reason: TitleValidationFailureReason;
      title: string;
    };

/**
 * 失敗した結果だけを表す
 * 失敗を前提とする処理が valid な結果を受け取らないようにする
 */
export type TitleValidationFailure = Extract<TitleValidationResult, { valid: false }>;

const CONVENTIONAL_PR_TITLE_PATTERN = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
const allowedTypes: ReadonlySet<string> = new Set(ALLOWED_PR_TITLE_TYPES);
const invalidScopeCharacter = /[^a-z\d\-._/]/;
const invalidScopeBoundary = /^[^a-z\d]|[^a-z\d]$/;
const invalidDescriptionStart = /^[^a-z\d\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
// 全角の句読点と記号は disallowedFullwidthSymbol が先に弾くため、ここでは ASCII だけを見る
const invalidDescriptionEnd = /[.,;:!?\s]$/;
// 絵文字の ZWJ 連結（U+200D で結合された Extended_Pictographic の列
// skin-tone modifier と VS16 を許容する）
const emojiZwjSequence =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)+/gu;
// 制御文字と書式文字（Cc, Cf）、および通常スペース以外の空白（NBSP など）
// 絵文字の ZWJ 連結を除いた残りに含まれれば拒否する
const disallowedInvisibleCharacter = /\p{Cc}|\p{Cf}|[^\S ]/u;
// 全角・CJK の記号と句読点
// 日本語入力から入る一般句読点（… ※ — “ ”）も範囲に含める
// 範囲と \p{P}\p{S} の交差を取るため、範囲内でも記号ではない 々 〆 〇 と全角英数字は拒否しない
// 長音符 ー、絵文字、ASCII の記号は範囲の外にあり、そもそも判定の対象にならない
const disallowedFullwidthSymbol =
  /[[\u2014\u2015\u2018\u2019\u201C\u201D\u2026\u203B\u3000-\u303F\u30A0\u30FB\uFF01-\uFF65\uFFE0-\uFFEE]&&[\p{P}\p{S}]]/v;

const isAllowedType = (value: string): value is PullRequestTitleType => allowedTypes.has(value);

const invalidResult = (title: string, reason: TitleValidationFailureReason): TitleValidationResult => ({
  valid: false,
  reason,
  title,
});

export const validatePullRequestTitle = (title: string): TitleValidationResult => {
  if (title.trim().length === 0) return invalidResult(title, "empty");
  if (title.trim() !== title) return invalidResult(title, "surrounding_whitespace");

  // 改行や垂直タブなどの制御文字、zero-width space, NBSP などの不可視文字を途中に含む title を拒否する
  // U+200D (ZWJ) は絵文字の ZWJ 連結を構成する場合のみ許可し、裸の ZWJ は拒否する
  if (disallowedInvisibleCharacter.test(title.replace(emojiZwjSequence, ""))) {
    return invalidResult(title, "invalid_format");
  }

  // 全角・CJK の記号はタイトルのどこにも置けないようにする
  // description の末尾だけでなく途中も対象にする
  if (disallowedFullwidthSymbol.test(title)) return invalidResult(title, "fullwidth_symbol");

  const match = CONVENTIONAL_PR_TITLE_PATTERN.exec(title);
  if (!match) return invalidResult(title, "invalid_format");

  const [, type, scope, breakingMarker, description] = match;
  if (!type || !description) return invalidResult(title, "invalid_format");
  if (!isAllowedType(type)) return invalidResult(title, "unsupported_type");

  if (
    scope !== undefined &&
    (invalidScopeCharacter.test(scope) ||
      invalidScopeBoundary.test(scope) ||
      scope.includes("//") ||
      (scope.match(/\//g) ?? []).length > 1)
  ) {
    return invalidResult(title, "invalid_scope");
  }

  if (invalidDescriptionStart.test(description)) {
    return invalidResult(title, "invalid_description");
  }
  if (invalidDescriptionEnd.test(description)) return invalidResult(title, "invalid_description");

  return {
    valid: true,
    title,
    parsed: {
      type,
      scope,
      breaking: breakingMarker === "!",
      description,
    },
  };
};
