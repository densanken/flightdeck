import { describe, expect, it } from "vitest";

import { ALLOWED_PR_TITLE_TYPES, hasDraftTitleMarker, validatePullRequestTitle } from "./index.js";

describe("validatePullRequestTitle", () => {
  it("type の allow-list を公開する", () => {
    expect(ALLOWED_PR_TITLE_TYPES).toEqual([
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
    ]);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    [" feat: add feature", "surrounding_whitespace"],
    ["feat: add feature ", "surrounding_whitespace"],
    ["feat: add\rfeature", "invalid_format"],
    ["feat: add\nfeature", "invalid_format"],
    ["[WIP] feat: add feature", "invalid_format"],
  ] as const)("失敗理由と入力 title を返す: %j", (title, reason) => {
    expect(validatePullRequestTitle(title)).toEqual({ valid: false, reason, title });
  });

  // --- 途中の制御・書式文字は拒否 ---
  it.each([
    ["feat: add\vfeature", "vertical tab"],
    ["feat: add\ffeature", "form feed"],
    ["feat: add​feature", "zero-width space"],
    ["feat: add\0feature", "null"],
    ["feat: add­feature", "soft hyphen"],
    ["feat: add﻿feature", "byte order mark"],
  ])("途中に制御・書式文字を含む title を拒否する: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_format");
    }
  });

  // --- 通常の title は制御文字ガードで誤検知しない ---
  it.each(["feat: add new feature", "feat: ログイン機能を追加", "feat: add 🎉 feature", "fix(auth): resolve issue"])(
    "制御文字を含まない title は引き続き valid: %s",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(true);
    }
  );

  // --- ZWJ 連結の絵文字は valid（U+200D は書式文字ガードから除外） ---
  it.each(["feat: add 👩‍💻 mode", "fix: enable 🏳️‍🌈 theme", "feat: show 👨‍👩‍👧 view", "feat: add 🚀 feature"])(
    "ZWJ 連結の絵文字を含む title は valid: %s",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(true);
    }
  );

  // subject 先頭の絵文字は invalidDescriptionStart で弾かれるが、
  // U+200D 由来の invalid_format では拒否されないことを確認する
  it.each(["fix: 🏳️‍🌈 theme", "feat: 👨‍👩‍👧 view"])(
    "先頭が ZWJ 絵文字の title は invalid_format では拒否しない: %s",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("invalid_description");
      }
    }
  );

  // --- 基本: 全 type ---
  it.each([
    "feat: add new feature",
    "fix: resolve bug",
    "docs: update readme",
    "style: format code",
    "refactor: restructure module",
    "perf: optimize query",
    "test: add unit tests",
    "build: update deps",
    "ci: fix pipeline",
    "chore: cleanup",
    "revert: undo change",
  ])("有効な title を受け入れる: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(true);
  });

  it("scope なしの title の構成要素を返す", () => {
    const result = validatePullRequestTitle("feat: add new feature");
    expect(result).toEqual({
      valid: true,
      title: "feat: add new feature",
      parsed: {
        type: "feat",
        scope: undefined,
        breaking: false,
        description: "add new feature",
      },
    });
  });

  // --- scope ---
  it("scope ありの title を受け入れる", () => {
    const result = validatePullRequestTitle("feat(auth): add login");
    expect(result).toEqual({
      valid: true,
      title: "feat(auth): add login",
      parsed: {
        type: "feat",
        scope: "auth",
        breaking: false,
        description: "add login",
      },
    });
  });

  it.each([
    "feat(api-gateway): add endpoint",
    "fix(auth.oauth): resolve issue",
    "feat(v2): add endpoint",
    "fix(my_module): resolve bug",
    "feat(123): handle case",
    "feat(packages/core): add feature",
    "feat(a): single char scope",
    "feat(0): single digit scope",
    "feat(a/b): minimal slash scope",
    "feat(a-b/c-d): slash and hyphen combined",
    "feat(a--b): consecutive hyphens",
    "feat(a..b): consecutive dots",
    "feat(a__b): consecutive underscores",
  ])("記号・数字を含む scope を受け入れる: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(true);
  });

  // --- breaking change ---
  it.each([
    "feat!: breaking change",
    "chore!: drop node 14",
    "fix(core)!: remove deprecated api",
    "feat(api)!: breaking change",
  ])("breaking change marker ありの title を受け入れる: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(true);
  });

  it("breaking change marker ありの title の構成要素を返す", () => {
    const result = validatePullRequestTitle("feat!: breaking change");
    expect(result).toEqual({
      valid: true,
      title: "feat!: breaking change",
      parsed: {
        type: "feat",
        scope: undefined,
        breaking: true,
        description: "breaking change",
      },
    });
  });

  // --- breaking change の最小ケース ---
  it("scope + breaking change + 最小 subject を受け入れる", () => {
    const result = validatePullRequestTitle("feat(a)!: x");
    expect(result).toEqual({
      valid: true,
      title: "feat(a)!: x",
      parsed: {
        type: "feat",
        scope: "a",
        breaking: true,
        description: "x",
      },
    });
  });

  // --- revert: type: 形式 ---
  it.each([
    "revert: feat: add new feature",
    "revert: chore: cleanup deps",
    "revert: fix(auth): broken login",
    "revert: feat!: breaking change",
    "revert: refactor(core): restructure",
    "revert: revert: double revert",
  ])("revert: type: 形式を受け入れる: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(true);
  });

  it("revert: type: 形式の構成要素を返す", () => {
    const result = validatePullRequestTitle("revert: feat: add new feature");
    expect(result).toEqual({
      valid: true,
      title: "revert: feat: add new feature",
      parsed: {
        type: "revert",
        scope: undefined,
        breaking: false,
        description: "feat: add new feature",
      },
    });
  });

  // --- 日本語 subject ---
  it.each([
    "feat: ログイン機能を追加",
    "fix(auth): 認証バグを修正",
    "feat!: 破壊的変更を含む",
    "docs: update READMEの日本語セクション",
    "refactor(api): エンドポイントの整理",
    "feat: add 🎉 feature",
    "feat: あいうえお",
    "feat: カタカナのみ",
    "feat: 漢字のみ",
    "feat: ひらがなで終わる",
    "feat: カタカナで終わる機能テスト",
    "fix: 修正した",
  ])("日本語 subject を受け入れる: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(true);
  });

  // --- 日本語 scope は拒否 ---
  it.each([
    "feat(認証): add login",
    "feat(ひらがな): add feature",
    "feat(カタカナ): add feature",
    "feat(認証-oauth): add login",
    "feat(auth.認証): add login",
    "feat(認証/oauth): add login",
  ])("日本語を含む scope を拒否する: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_scope");
    }
  });

  // --- subject のバリエーション ---
  it.each([
    "fix: resolve #123",
    "fix: 2nd attempt at fix",
    "feat: add foo-bar feature",
    "fix: handle edge case (null input)",
    "feat: add `foo` method",
    "feat: add foo/bar support",
    "ci: a",
    "feat: 1",
    "feat: あ",
    "feat: 123",
  ])("subject のバリエーションを受け入れる: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(true);
  });

  // --- 構文エラー系: パターン不一致 ---
  it.each([
    "no type here",
    "feat:missing space",
    "feat : extra space before colon",
    "feat: ",
    ": no type",
    "",
    " feat: add feature",
    "機能: ログインを追加",
    "修正: バグを直す",
    "feat!!: double bang",
    "feat(scope) : space before colon",
    "feat(scope):: double colon",
    "feat:\tadd feature",
    "feat:\nadd feature",
  ])("パターンに一致しない title を拒否する: '%s'", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
  });

  // --- type エラー系 ---
  it.each([
    "invalid: no such type",
    "Feat: add feature",
    "FIX: resolve bug",
    "CHORE: cleanup",
    "a: single char type",
    "feat2: type with number",
    "123: numeric type",
    "feat_fix: type with underscore",
  ])("許可されていない type を拒否する: '%s'", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("unsupported_type");
    }
  });

  // --- scope の大文字 ---
  it.each([
    "feat(Auth): add login",
    "fix(API): resolve bug",
    "refactor(MyModule): restructure",
    "feat(SCOPE)!: breaking change",
    "fix(Auth-Service): resolve bug",
  ])("大文字を含む scope を拒否する: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_scope");
    }
  });

  // --- scope の不正な文字 ---
  it.each([
    "feat(a b): space in scope",
    "feat(a!b): bang in scope",
    "feat(a,b): comma in scope",
    "feat(a@b): at sign in scope",
    "feat(a#b): hash in scope",
    "feat(a$b): dollar in scope",
    "feat(a;b): semicolon in scope",
    "feat(a:b): colon in scope",
  ])("不正な文字を含む scope を拒否する: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_scope");
    }
  });

  // --- scope の先頭末尾が記号 ---
  it.each([
    "feat(-auth): leading hyphen",
    "feat(auth-): trailing hyphen",
    "feat(.auth): leading dot",
    "feat(auth.): trailing dot",
    "feat(_auth): leading underscore",
    "feat(auth_): trailing underscore",
    "feat(-): hyphen only",
    "feat(.): dot only",
    "feat(_): underscore only",
    "feat(/): slash only",
  ])("先頭または末尾が記号の scope を拒否する: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_scope");
    }
  });

  // --- scope のスラッシュ制限 ---
  it.each(["feat(packages/core1/core2): nested slash", "fix(a/b/c): triple slash", "feat(a//b): consecutive slashes"])(
    "スラッシュが 2 つ以上ある scope を拒否する: %s",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("invalid_scope");
      }
    }
  );

  it.each(["feat(packages/): trailing slash", "feat(/core): leading slash"])(
    "先頭または末尾がスラッシュの scope を拒否する: %s",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("invalid_scope");
      }
    }
  );

  // --- scope の構文エラー ---
  it.each([
    "feat(): add feature",
    "feat(scope: missing closing paren",
    "feat((scope)): double parens",
    "feat((scope): opening paren in scope",
  ])("不正な scope 構文を拒否する: '%s'", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
  });

  // --- subject の先頭不正 ---
  it.each([
    "feat: Add new feature",
    "fix: Resolve bug",
    "docs: Update readme",
    "feat(auth): Add login",
    "revert: Fix(auth): broken login",
    "chore!: Remove deprecated code",
  ])("大文字で始まる subject を拒否する: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_description");
    }
  });

  it("空白始まりの subject を拒否する", () => {
    const result = validatePullRequestTitle("feat:  double space");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_description");
    }
  });

  it.each([
    "feat: #123 fix something",
    "feat: (parenthesized) subject",
    "feat: -hyphen start",
    "feat: @mention something",
    "feat: _underscore start",
    "feat: /slash start",
    "feat: [bracketed] subject",
    "feat: !important",
    "feat: 🎉 emoji start",
    "feat: élan update",
  ])("記号始まりの subject を拒否する: '%s'", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_description");
    }
  });

  // --- subject の末尾不正 ---
  // 末尾の ASCII 記号は invalid_description になる
  it.each([
    "fix: resolve bug.",
    "feat: add feature!",
    "feat: add feature?",
    "feat: add feature;",
    "feat: add feature:",
    "feat: add feature,",
  ])("末尾に ASCII の記号がある subject を invalid_description で拒否する: '%s'", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_description");
    }
  });

  // 末尾の全角記号は disallowedFullwidthSymbol が invalidDescriptionEnd より先に評価されるため
  // invalid_description ではなく fullwidth_symbol になる
  it.each([
    "feat: 機能を追加。",
    "feat: 機能を追加、",
    "feat: 機能を追加！",
    "feat: 機能を追加？",
    "feat: 機能を追加：",
    "feat: add feature，",
    "feat: add feature．",
  ])("末尾に全角の記号がある subject を fullwidth_symbol で拒否する: '%s'", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("fullwidth_symbol");
    }
  });

  // --- 全角記号ガード ---
  // 全角セミコロン U+FF1B は以前 invalidDescriptionEnd の文字集合から漏れており valid になっていた
  it("末尾の全角セミコロンを含む title を fullwidth_symbol で拒否する", () => {
    const result = validatePullRequestTitle("feat: add login；");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("fullwidth_symbol");
    }
  });

  // 判定対象は description の末尾ではなく title 全体のため、途中に置いた全角記号も拒否する
  it.each([
    ["全角括弧", "feat: 対応（暫定）を追加"],
    ["鉤括弧", "feat: 「認証」まわりを整理"],
    ["三点リーダ", "feat: 修正しました…"],
    ["波ダッシュ", "feat: A〜B を統合"],
    ["中黒", "feat: A・B を統合"],
    ["全角コロン", "feat： add feature"],
  ])("末尾以外に全角の記号を含む title を fullwidth_symbol で拒否する: %s", (_label, title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("fullwidth_symbol");
    }
  });

  // 範囲内でも一般カテゴリが記号でも句読点でもない文字（々 〆 〇 と全角英数字）は交差から外れる
  // 長音符 ー、絵文字、ASCII 記号は範囲の外にあるため、そもそも判定の対象にならない
  it.each([
    ["々（Lm）", "feat: 時々失敗するテストを修正"],
    ["長音符（Lm）", "feat: サーバーを追加"],
    ["〇（Nl）", "feat: 第〇章を追加"],
    ["〆（Lo）", "feat: 期日〆を設定"],
    ["全角英字（Lu）", "feat: プランＡを追加"],
    ["全角数字（Nd）", "feat: フェーズ１を追加"],
    ["ZWJ 連結の絵文字", "feat: add 👩‍💻 mode"],
    ["issue 番号", "fix: resolve #123"],
    ["ASCII 括弧", "feat: handle edge case (null input)"],
  ])("全角記号ガードで巻き込んではいけない title は引き続き valid: %s", (_label, title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(true);
  });

  it("不可視文字 + 全角記号 → 不可視文字のエラーが先", () => {
    const result = validatePullRequestTitle("feat: a\u200Bb（暫定）");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_format");
    }
  });

  it.each([
    ["形式不一致", "feat 対応（暫定）"],
    ["未知の type", "hotfix: 対応（暫定）"],
  ])("全角記号 + %s → 全角記号のエラーが先", (_label, title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("fullwidth_symbol");
    }
  });

  it("全角記号 + scope 不正 → 全角記号のエラーが先", () => {
    const result = validatePullRequestTitle("feat(AB): 対応（暫定）を追加");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("fullwidth_symbol");
    }
  });

  // --- subject 途中の大文字は許容 ---
  it.each(["feat: add FOO_BAR constant", "fix: update README section", "feat: integrate OAuth flow"])(
    "subject 途中の大文字を許容する: %s",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(true);
    }
  );

  // --- revert の不正な形式 ---
  it.each(["Revert: chore: cleanup", "REVERT: feat: add feature"])("大文字の Revert を拒否する: %s", (title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("unsupported_type");
    }
  });

  it.each(["revert chore: cleanup", "revert fix(auth): broken login"])(
    "colon なしの revert を拒否する: '%s'",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(false);
    }
  );

  // --- バリデーション優先順位 ---
  it("scope 大文字 + subject 大文字 → scope のエラーが先", () => {
    const result = validatePullRequestTitle("feat(AB): Add feature");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_scope");
    }
  });

  it("scope 不正文字 + subject 大文字 → scope のエラーが先", () => {
    const result = validatePullRequestTitle("feat(a!b): Add feature");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_scope");
    }
  });

  it("subject 大文字 + 末尾ピリオド → 大文字のエラーが先", () => {
    const result = validatePullRequestTitle("feat: Add feature.");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_description");
    }
  });

  // --- 不可視文字ガード: 裸の不可視文字は拒否し、絵文字の ZWJ 連結のみ許可する ---
  // ZWSP と同様に、絵文字連結とは無関係な語中/末尾の単独 ZWJ(U+200D) や NBSP(U+00A0) も
  // invalid_format で拒否する
  // 絵文字の ZWJ 連結（family emoji 等）は emojiZwjSequence 除去により valid のまま
  it.each([
    ["語中の単独 ZWJ", "feat: a\u200Db"],
    ["末尾の単独 ZWJ", "feat: add\u200D"],
    ["語中の NBSP", "feat: a\u00A0b"],
  ])("裸の不可視文字を含む description は invalid_format で拒否する: %s", (_label, title) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_format");
    }
  });

  it("scope 内の裸の ZWJ は invalid_format で拒否する", () => {
    // 不可視文字ガードが scope 解析より先に評価されるため invalid_scope ではなく invalid_format になる
    const title = "feat(a\u200Db): x";
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_format");
    }
  });

  // --- ReDoS / 病的長入力の回帰ガード ---
  // 実装の正規表現はすべて線形（ネスト量化子なし）であり、200k 文字級・開き括弧連打・
  // バックトラック誘発形のいずれも例外を投げず指定 reason を即座に返す
  // 時間上限は環境差で flaky にならないよう十分緩く 1000ms とする
  it.each([
    ["200k 文字の description", "feat: " + "a".repeat(200000), true, undefined],
    ["100k 個の開き括弧", "feat" + "(".repeat(100000) + ": x", false, "invalid_format"],
    ["200k 文字の type", "w".repeat(200000) + ": x", false, "unsupported_type"],
    ["200k 文字の scope", "feat(" + "a".repeat(200000) + "): x", true, undefined],
    ["バックトラック誘発形の scope", "feat(" + "a(".repeat(50000) + "): x", false, "invalid_scope"],
  ] as const)("病的長入力を例外なく緩い時間内で判定する: %s", (_label, title, valid, reason) => {
    const start = Date.now();
    const result = validatePullRequestTitle(title);
    const elapsed = Date.now() - start;
    expect(result.valid).toBe(valid);
    if (!result.valid) expect(result.reason).toBe(reason);
    expect(elapsed).toBeLessThan(1000);
  });

  // --- workflow 整合（runtime-accepted ⊆ workflow-accepted）の cross-check ---
  // semantic-pr-title.yml の disallowScopes(.*[A-Z].*) / subjectPattern(^(?![A-Z]).+$) /
  // action の default type 集合が確実に拒否する代表入力を、runtime も必ず拒否することを固定する
  // 両者の受理集合の包含が崩れると preflight と semantic-pr-title で判定が
  // 食い違い、片方が OK・片方が失敗という矛盾が起きうる
  it.each([
    ["feat(Auth): x", "invalid_scope"], // workflow: disallowScopes .*[A-Z].*
    ["feat: Add x", "invalid_description"], // workflow: subjectPattern ^(?![A-Z]).+$
    // 以下は action の default type 集合に無い未知 type（workflow も拒否する）
    // wip: は semantic-pr-title.yml の wip:true でスキップ通過するため代表に使わない
    ["hotfix: x", "unsupported_type"],
    ["update: x", "unsupported_type"],
    ["merge: x", "unsupported_type"],
    ["release: x", "unsupported_type"],
  ] as const)("workflow が確実に拒否する代表 title を runtime も拒否する: %j", (title, reason) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe(reason);
    }
  });

  it("ALLOWED_PR_TITLE_TYPES は semantic-pr-title の action が受理する type 集合の部分集合である", () => {
    // semantic-pr-title.yml は types を上書きしないため、workflow の受理 type 集合は
    // amannn/action-semantic-pull-request の default（conventional-commit 標準 11 種）と一致する
    // runtime がこの集合に無い type を受理すると preflight と workflow で判定が食い違うため、
    // ALLOWED_PR_TITLE_TYPES への非標準 type 追加をこの subset 検査で検知する
    // 注: action 側 default の変化は hermetic な unit test では検知できないため、
    // action を更新した際はこの literal を手動で追従させる必要がある
    const actionAcceptedTypes = new Set([
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
    ]);
    // guard が空振り（全 type を含む集合との比較で必ず空になる）でないことを担保する
    expect(actionAcceptedTypes.has("wip")).toBe(false);
    expect(actionAcceptedTypes.has("hotfix")).toBe(false);
    const outside = [...ALLOWED_PR_TITLE_TYPES].filter((type) => !actionAcceptedTypes.has(type));
    expect(outside).toEqual([]);
  });

  // --- 許可すべき絵文字の許可方向を広げる ---
  // keycap(U+0031 FE0F 20E3) / regional flag(RI ペア) / 単独 FE0F(U+2764 FE0F) は
  // いずれも Cc/Cf を含まない（FE0F は Mn、RI は So）ため valid になる
  // FE0F や Me/So を巻き添えにする regression をこの許可方向で検知する
  it.each(["feat: add 1️⃣ step", "feat: add 🇯🇵 support", "feat: add ❤️ love"])(
    "許可すべき絵文字（keycap / regional flag / 単独 FE0F）を含む title は valid: %s",
    (title) => {
      const result = validatePullRequestTitle(title);
      expect(result.valid).toBe(true);
    }
  );

  it("subdivision flag（tag 系絵文字）は現状 invalid_format で拒否する", () => {
    // 🏴 + tag 文字(U+E0067 等) は tag 文字が Cf で ZWJ 免除の対象外のため現状拒否される
    // 許可すべきと判断するなら期待反転のうえ実装修正が必要という判断材料になる
    const title = "feat: add 🏴󠁧󠁢󠁳󠁣󠁴󠁿 flag";
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_format");
    }
  });

  // --- valid ケースの parsed 分解を検証する ---
  it("slash を含む scope の parsed を検証する", () => {
    const result = validatePullRequestTitle("feat(a/b): x");
    expect(result).toEqual({
      valid: true,
      title: "feat(a/b): x",
      parsed: { type: "feat", scope: "a/b", breaking: false, description: "x" },
    });
  });

  it("scope + breaking を同時に含む parsed を検証する", () => {
    const result = validatePullRequestTitle("fix(core)!: drop it");
    expect(result).toEqual({
      valid: true,
      title: "fix(core)!: drop it",
      parsed: { type: "fix", scope: "core", breaking: true, description: "drop it" },
    });
  });

  it("revert 入れ子の description に元 title 全体を抽出する", () => {
    const result = validatePullRequestTitle("revert: fix(auth): broken login");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed).toEqual({
        type: "revert",
        scope: undefined,
        breaking: false,
        description: "fix(auth): broken login",
      });
    }
  });

  // --- surrounding_whitespace の非空白バリエーションと優先順位 ---
  // title.trim() は Unicode 空白（TAB / NBSP など）も除去するため、それらが先頭末尾に
  // ある場合は surrounding_whitespace になり、TAB のみの title は empty になる
  it.each([
    ["\tfeat: add feature", "surrounding_whitespace"], // 先頭 TAB
    [" feat: add feature", "surrounding_whitespace"], // 先頭 NBSP
    ["feat: add feature ", "surrounding_whitespace"], // 末尾 NBSP
    ["\t", "empty"], // TAB のみ
  ] as const)("非空白の周囲空白を含む title の reason を固定する: %j", (title, reason) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe(reason);
    }
  });

  it("周囲空白は制御文字ガードより先に発火する", () => {
    // 先頭スペース + 語中 ZWSP: 制御ガード単独なら invalid_format だが、先に評価される
    // surrounding_whitespace(:59) が制御ガード(:62) を上書きする優先順位を固定する
    const title = " feat: a​b";
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("surrounding_whitespace");
    }
  });

  // --- 一部 invalid 群の reason を固定する ---
  it.each([
    ["feat:missing space", "invalid_format"], // colon 後にスペースが無くパターン不一致
    ["feat(): add feature", "invalid_format"], // 空 scope は ([^)]+) に不一致で全体マッチ失敗
    ["revert chore: cleanup", "invalid_format"], // revert の後に colon が無くパターン不一致
  ] as const)("構文不一致の title の reason を固定する: %j", (title, reason) => {
    const result = validatePullRequestTitle(title);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe(reason);
    }
  });
});

describe("hasDraftTitleMarker", () => {
  it.each([
    "[WIP] feat: add login",
    "[wip] feat: add login",
    "WIP: add login",
    "wip: add login",
    "[Draft] feat: x",
    "draft: x",
    "  [WIP] feat: x",
  ])("%s を作業中の接頭辞として検出する", (title) => {
    expect(hasDraftTitleMarker(title)).toBe(true);
  });

  it.each([
    "feat: add login",
    "feat(wip): add login",
    "feat: WIP を解消する",
    "wipe: add login",
    "[WIPE] feat: x",
    "fix: draft を削除",
  ])("%s は接頭辞として扱わない", (title) => {
    expect(hasDraftTitleMarker(title)).toBe(false);
  });
});
