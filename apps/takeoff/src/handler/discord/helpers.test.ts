import { describe, expect, it } from "vitest";

import { appendLinesWithinLimit, getJapaneseErrorMessage, parsePrNumber } from "./helpers.js";
import { AppError, errors } from "../../domain/errors.js";

describe("getJapaneseErrorMessage", () => {
  const cases: { name: string; error: AppError; expected: string }[] = [
    {
      name: "repo_not_registered",
      error: errors.repoNotRegistered(),
      expected: "指定されたリポジトリは登録されていません。",
    },
    {
      // repo_not_found は factory が無いため直接構築する
      name: "repo_not_found",
      error: new AppError("repo_not_found", "not found"),
      expected: "指定されたリポジトリが見つからないか、GitHub App からアクセスできません。",
    },
    { name: "pr_not_found", error: errors.prNotFound(), expected: "指定された PR が見つかりません。" },
    { name: "pr_not_open", error: errors.prNotOpen(), expected: "PR が open ではありません。" },
    { name: "pr_is_draft", error: errors.prIsDraft(), expected: "PR が draft です。" },
    {
      name: "pr_recently_updated",
      error: errors.prRecentlyUpdated(),
      expected: "PR の最終更新から 1 分経過していません。しばらく待ってから再度実行してください。",
    },
    {
      name: "pr_title_marked_draft",
      error: errors.prTitleMarkedDraft(),
      expected: "PR title に draft を示す接頭辞が付いています。",
    },
    { name: "merge_conflict", error: errors.mergeConflict(), expected: "マージコンフリクトがあります。" },
    {
      name: "merge_blocked",
      error: new AppError("merge_blocked", "blocked"),
      expected: "ブランチプロテクションなどにより GitHub がマージを拒否しました。",
    },
    {
      name: "mergeability_checking",
      error: errors.mergeabilityChecking(),
      expected: "GitHub がマージ可能性を確認中です。10 秒ほど待ってからもう一度実行してください。",
    },
    { name: "checks_pending", error: errors.checksPending({}), expected: "一部の check がまだ実行中です。" },
    { name: "checks_failed", error: errors.checksFailed({}), expected: "一部の check が失敗しています。" },
    {
      name: "statuses_pending",
      error: errors.statusesPending({}),
      expected: "一部の status check がまだ完了していません。",
    },
    { name: "statuses_failed", error: errors.statusesFailed({}), expected: "一部の status が失敗しています。" },
    {
      name: "checks_not_registered",
      error: errors.checksNotRegistered(),
      expected: "GitHub Actions の check run が見つからないため、マージできません。",
    },
    {
      name: "pull_request_changed",
      error: errors.pullRequestChanged(),
      expected: "check の再取得中に PR のマージ対象が変わりました。再度実行してください。",
    },
    {
      name: "head_sha_changed",
      error: errors.headShaChanged(),
      expected: "マージ直前に PR の head SHA が変更されました。",
    },
    {
      name: "merge_cooldown",
      error: errors.mergeCooldown(),
      expected: "同じ PR へのマージを短い間隔で実行しています。しばらく待ってからもう一度実行してください。",
    },
    {
      name: "sync_cooldown",
      error: errors.syncCooldown(),
      expected: "同じリポジトリへの同期を短い間隔で実行しています。しばらく待ってからもう一度実行してください。",
    },
    { name: "role_required", error: errors.roleRequired(), expected: "この操作は管理担当者のみが行うことができます。" },
    {
      name: "github_rate_limited",
      error: errors.githubRateLimited(),
      expected: "GitHub API のレート制限に達しました。",
    },
    {
      name: "github_app_permission_missing",
      error: errors.githubAppPermissionMissing(),
      expected: "GitHub App の権限が不足しています。",
    },
    {
      name: "unexpected_github_error",
      error: errors.unexpectedGithubError("boom"),
      expected: "GitHub API との通信に失敗しました。",
    },
    {
      name: "unexpected_discord_error",
      error: errors.unexpectedDiscordError("boom"),
      expected: "Discord API との通信に失敗しました。",
    },
  ];

  it.each(cases)("$name を対応する日本語へ写像する", ({ error, expected }) => {
    expect(getJapaneseErrorMessage(error)).toBe(expected);
  });

  it("runs_awaiting_approval を fork PR 承認の案内へ写像する", () => {
    const message = getJapaneseErrorMessage(errors.runsAwaitingApproval());
    expect(message).toContain("承認待ちの action_required workflow run が残っています。");
    expect(message).toContain("メンテナが GitHub 上で承認してから再度実行してください。");
  });

  it("invalid_pr_title は Conventional PR Title の案内と元 message を含める", () => {
    const message = getJapaneseErrorMessage(errors.invalidPrTitle("PR title must not be empty"));
    expect(message).toContain("PR title が Conventional PR Title に準拠していません。");
    expect(message).toContain("https://www.conventionalcommits.org/");
    expect(message).toContain("PR title must not be empty");
  });

  it("invalid_request は元 message をそのまま返す", () => {
    expect(getJapaneseErrorMessage(errors.invalidRequest("repo が指定されていません。"))).toBe(
      "repo が指定されていません。"
    );
  });

  it("table に無い未知の AppError type はフォールバック文言へ写像する", () => {
    const unknown = new AppError("some_new_type" as never, "detailed message");
    expect(getJapaneseErrorMessage(unknown)).toBe("エラーが発生しました: detailed message");
  });

  it("github_rules_api_unavailable は既存の詳細 message fallback を維持する", () => {
    const error = new AppError("github_rules_api_unavailable", "Rules API unavailable");
    expect(getJapaneseErrorMessage(error)).toBe("エラーが発生しました: Rules API unavailable");
  });

  it("AppError でない値は予期しないエラー文言へフォールバックする", () => {
    expect(getJapaneseErrorMessage(new Error("plain error"))).toBe("予期しないエラーが発生しました。");
    expect(getJapaneseErrorMessage("string error")).toBe("予期しないエラーが発生しました。");
    expect(getJapaneseErrorMessage(undefined)).toBe("予期しないエラーが発生しました。");
  });
});

describe("parsePrNumber", () => {
  it("10 進数の正の整数だけを PR 番号として受理する", () => {
    expect(parsePrNumber("42")).toBe(42);
    for (const value of ["0x10", "5e2", " 5 ", "0", "-1", "", "1".repeat(400), "9007199254740993"]) {
      expect(() => parsePrNumber(value)).toThrow(errors.invalidRequest("PR 番号が無効です。"));
    }
  });
});

describe("appendLinesWithinLimit", () => {
  it("収まらない行は「…ほか N 件」にまとめ、後続が残るときだけその分を空けておく", () => {
    // "head\n- a" は 8 文字、まとめ行 "\n- …ほか N 件" は 10 文字
    expect(appendLinesWithinLimit("head", ["- a", "- b", "- c"], 18)).toBe("head\n- a\n- …ほか 2 件");
    // 最後の行は収まれば「…ほか 1 件」にせず出す
    expect(appendLinesWithinLimit("head", ["- a", "- b"], 18)).toBe("head\n- a\n- b");
  });

  it("まとめ行の件数の桁が変わっても上限を超えない", () => {
    const lines = Array.from({ length: 12 }, () => "- a");
    for (let maxLength = 20; maxLength <= 60; maxLength++) {
      expect(appendLinesWithinLimit("head", lines, maxLength).length).toBeLessThanOrEqual(maxLength);
    }
  });
});
