import { describe, expect, it } from "vitest";

import { authorizationComment, checkOutput, closedComment } from "./authorization.js";
import { consentLabels } from "../domain/merge-request.js";

import type { EvaluationResult } from "../usecase/evaluate/interface.js";

const facts = {
  authorRoots: [],
  otherPaths: ["scripts/test.sh"],
  invalidCommits: [
    {
      sha: "a",
      authorId: null,
      authorEmail: "person@example.com",
      committerId: 1,
      committerLogin: "alice",
      signature: null,
    },
    {
      sha: "b",
      authorId: null,
      authorEmail: "123+alice@users.noreply.github.com",
      committerId: 1,
      committerLogin: "alice",
      signature: null,
    },
  ],
};

describe("authorizationComment", () => {
  it("認可済みでも authors/ 以外の変更があれば、レビューが必要なことを見出しと案内で示す", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      facts: { authorRoots: ["alice"], otherPaths: ["README.md"], invalidCommits: [] },
    });
    expect(body).toContain("## `authors/` 以外の変更にレビューが必要です");
    expect(body).toContain("### <code>authors/</code> 以外の変更（1 件）\n\n- ` README.md `");
    expect(body).toContain("App はこの PR を Approve しません");
    expect(body).not.toContain("## マージできます");
  });

  it.each([
    [{ status: "allowed", reason: "AUTHORIZED" }, "TIP"],
    [{ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, "NOTE"],
    [{ status: "waiting", reason: "EVALUATING" }, "IMPORTANT"],
    [{ status: "rejected", reason: "INVALID_PROFILE" }, "WARNING"],
    [{ status: "error", reason: "API_ERROR" }, "CAUTION"],
  ] as const)("状態に対応するアラートを表示する", (result, alert) => {
    expect(authorizationComment(result)).toContain(`> [!${alert}]`);
  });

  it("認可済みの文言は他の人の Approve を前提にしない", () => {
    const body = authorizationComment({ status: "allowed", reason: "AUTHORIZED" });
    expect(body).toContain("> `authors/` の変更に問題はありません。");
    expect(body).toContain("| 状態 | authors/ の変更に問題はありません（` AUTHORIZED `） |");
  });

  it("表の変更するディレクトリに含まれる縦線をエスケープする", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      facts: { authorRoots: ["a|b"], otherPaths: [], invalidCommits: [] },
    });
    expect(body).toContain("| 変更するディレクトリ | ` authors/a\\|b/ ` |");
  });

  it("Org Member の対象外ファイルには削除を案内しない", () => {
    const body = authorizationComment({
      status: "not_applicable",
      reason: "NO_CONTENT_CHANGES",
      facts: { authorRoots: [], otherPaths: ["README.md"], invalidCommits: [] },
    });
    expect(body).toContain("README.md");
    expect(body).not.toContain("取り除いて");
    expect(body).not.toContain("git restore");
  });

  it("対象外ファイルの削除が必要なら一覧と手順を開いた状態で示す", () => {
    const body = authorizationComment({
      status: "rejected",
      reason: "NON_CONTENT_CHANGE_FORBIDDEN",
      facts: { authorRoots: [], otherPaths: ["README.md"], invalidCommits: [] },
    });
    expect(body).toContain("### <code>authors/</code> 以外の変更（1 件）\n\n- ` README.md `");
    expect(body).toContain("git restore");
  });

  it("Merge 依頼の待機条件を表示する", () => {
    expect(
      authorizationComment({
        status: "allowed",
        reason: "AUTHORIZED",
        merge: { request: "accepted", waiting: "CI_PENDING" },
      })
    ).toContain("CI の完了");
  });

  it.each([
    ["HISTORY_UNAVAILABLE", true],
    ["NOT_AUTHOR", false],
  ] as const)("%s の場合は理由に応じて案内する", (reason, consult) => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      merge: { request: "invalid", reason },
    });
    expect(body).toContain("PR 作成者がチェックを外して入れ直してください");
    expect(body.includes("管理者に相談してください")).toBe(consult);
  });

  it("壊れたチェック欄をテンプレートの 1 行に直すよう案内する", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      merge: { request: "invalid", reason: "INVALID_CHECKBOX" },
    });
    expect(body).toContain(
      "> [!WARNING]\n> **自動マージの依頼は無効です**\n> 理由: チェック欄の形式がテンプレートと異なります\n"
    );
    expect(body).toContain("テンプレートの 1 行（すべてのチェックが成功したら自動マージする）だけにしてからチェック");
    expect(body).not.toContain("- [ ]");
    expect(body).not.toContain("チェックを外して入れ直して");
    expect(body).not.toContain("管理者に相談");
  });

  it.each(["INTERVENTION_QUORUM_MISSING", "OFFBOARDING_APPROVAL_MISSING"] as const)(
    "%s では承認者の案内を表示する",
    (reason) => {
      const body = authorizationComment({ status: "waiting", reason });
      expect(body).toContain("Approve を依頼してください");
    }
  );

  it("管理介入の Approve 不足では、足りない内訳によらず同じ条件の表を表示する", () => {
    const missing = (details: EvaluationResult["details"]): string =>
      authorizationComment({ status: "waiting", reason: "INTERVENTION_QUORUM_MISSING", details });

    const body = missing(undefined);
    expect(body).toContain(
      "### Approve の条件\n\n管理介入には、現在のコミットへの次の Approve が必要です。\n\n| 条件 | 必要な人数 |\n| --- | --- |\n| PR 作成者以外の Approve | 4 人以上 |\n| 上のうち Org Owner の Approve | 1 人以上 |"
    );
    expect(missing({ root: "alice" })).toBe(body);
  });

  it("オフボーディングの Approve 不足では Org Owner の条件の表を表示する", () => {
    const body = authorizationComment({ status: "waiting", reason: "OFFBOARDING_APPROVAL_MISSING" });
    expect(body).toContain("| PR 作成者以外の Org Owner の Approve | 1 人以上 |");
    expect(body).not.toContain("4 人以上");
  });

  it("管理モードの条件は Approve が足りない状態以外では表示しない", () => {
    expect(authorizationComment({ status: "allowed", reason: "AUTHORIZED" })).not.toContain("Approve の条件");
    expect(authorizationComment({ status: "waiting", reason: "EDITOR_APPROVAL_MISSING" })).not.toContain(
      "Approve の条件"
    );
  });

  it("コミットの本人確認の結果を文で表示する", () => {
    const ok = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      facts: { authorRoots: ["alice"], otherPaths: [], invalidCommits: [] },
    });
    expect(ok).toContain("| コミットの本人確認 | すべてのコミットが PR 作成者と一致しました |");
    expect(authorizationComment({ status: "rejected", reason: "COMMIT_IDENTITY_MISMATCH", facts })).toContain(
      "| コミットの本人確認 | PR 作成者と一致しないコミットがあります |"
    );
    expect(authorizationComment({ status: "error", reason: "API_ERROR" })).toContain(
      "| コミットの本人確認 | 確認できませんでした |"
    );
  });

  it("コミットがない場合は本人確認が一致したと表示しない", () => {
    const body = authorizationComment({
      status: "rejected",
      reason: "COMMIT_IDENTITY_MISMATCH",
      facts: { authorRoots: [], otherPaths: [], invalidCommits: [] },
    });
    expect(body).toContain("| コミットの本人確認 | 確認できるコミットがありません |");
  });

  it("Renovate の PR は、Renovate 向けの状態と本人確認をしていないことを表示する", () => {
    const body = authorizationComment({
      status: "not_applicable",
      reason: "RENOVATE_UPDATE",
      facts: { authorRoots: [], otherPaths: ["package.json"], invalidCommits: [] },
    });

    expect(body).toContain("## 記事以外の変更です\n");
    expect(body).toContain("| 状態 | Renovate による依存関係の更新です（` RENOVATE_UPDATE `） |");
    expect(body).toContain("| コミットの本人確認 | Renovate の PR のため確認していません |");
  });

  it("管理介入とオフボーディングのときだけ実施内容の行を表示する", () => {
    const row = (management: EvaluationResult["management"]): boolean =>
      authorizationComment({ status: "allowed", reason: "AUTHORIZED", management }).includes("| 実施内容 |");

    expect(row({ mode: "intervention" })).toBe(true);
    expect(row({ mode: "offboarding" })).toBe(true);
    expect(row({ mode: "none" })).toBe(false);
    expect(row(undefined)).toBe(false);
  });

  it("管理介入とオフボーディングの実施内容を日本語で表示する", () => {
    expect(
      authorizationComment({ status: "allowed", reason: "AUTHORIZED", management: { mode: "intervention" } })
    ).toContain("| 実施内容 | 管理介入 |");
    expect(
      authorizationComment({ status: "allowed", reason: "AUTHORIZED", management: { mode: "offboarding" } })
    ).toContain("| 実施内容 | オフボーディング |");
  });

  it("管理介入とオフボーディングの申請が無効な理由と直し方を折りたたまずに表示する", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      management: { mode: "none", reason: "CONFLICT" },
    });
    expect(body).toContain(
      "> [!WARNING]\n> **管理介入・オフボーディングの申請は無効です**\n> 理由: 管理介入とオフボーディングの両方にチェックが入っています\n> どちらか一方だけにチェックを入れてください。"
    );
  });

  it("削除する Editor が未確認の場合はなしと区別する", () => {
    const body = authorizationComment({
      status: "rejected",
      reason: "OFFBOARDING_INVALID_CHANGES",
      management: { mode: "offboarding" },
    });
    expect(body).toContain("| 削除する Editor | 確認できませんでした |");
  });

  it("管理介入では削除する Editor を表示しない", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      management: { mode: "intervention", targets: [] },
    });
    expect(body).not.toContain("削除する Editor");
  });

  it("管理対象を表示する", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      management: {
        mode: "offboarding",
        targets: [
          { type: "user", login: "bob" },
          { type: "team", slug: "blog" },
        ],
      },
    });
    expect(body).toContain("` bob `, ` team:blog `");
  });

  it("Team の Approve は Maintainer 個人ではなく Team の条件で表示する", () => {
    const body = authorizationComment({
      status: "waiting",
      reason: "TEAM_MAINTAINER_REQUIRED",
      details: {
        root: "alice",
        missing: {
          kind: "all",
          editors: [
            { type: "team", slug: "blog" },
            { type: "user", login: "bob" },
          ],
        },
      },
    });
    expect(body).toContain("### Approve が必要な人");
    expect(body).toContain("| 削除する Editor の全員 | ` blog ` の Maintainer、` bob ` |");
  });

  it("どのディレクトリの変更が理由かを示して Approve が必要な人を案内する", () => {
    const body = authorizationComment({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      details: {
        root: "solo-team",
        missing: { kind: "one", editors: [{ type: "team", slug: "boarding-test-team" }] },
      },
    });
    expect(body).toContain("この PR は ` authors/solo-team/ ` を変更しているため、その Editor の Approve が必要です。");
    expect(body).toContain("| 現在の Editor のうち 1 人 | ` boarding-test-team ` のメンバー |");
  });

  it("website の Approve が不足しているときに Org Member の Editor を案内する", () => {
    const body = authorizationComment({
      status: "waiting",
      reason: "WEBSITE_MEMBER_CONSENT_MISSING",
      details: { root: "author" },
    });
    expect(body).toContain("| Editor のうち 1 人 | Org Member の Editor |");
  });

  it("自動マージを依頼していないときはチェック欄の案内を表示する", () => {
    const body = authorizationComment({ status: "allowed", reason: "AUTHORIZED", merge: { request: "none" } });
    expect(body).toContain("| 自動マージ | 依頼なし |");
    expect(body).toContain(
      "\n\n> [!TIP]\n> PR 本文のチェック欄（すべてのチェックが成功したら自動マージする）にチェックを付けると"
    );
    expect(body).not.toContain("- [ ]");
  });

  it.each(["rejected", "error", "not_applicable"] as const)("%s の PR には自動マージの依頼を案内しない", (status) => {
    const result = { status, reason: "API_ERROR", merge: { request: "none" } } as EvaluationResult;
    expect(authorizationComment(result)).not.toContain("チェックを付けると");
  });

  it("待機中の PR には自動マージの依頼を案内する", () => {
    const body = authorizationComment({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      merge: { request: "none" },
    });
    expect(body).toContain("チェックを付けると");
  });

  it.each([
    [{ request: "accepted", waiting: undefined }, undefined, "受け付けました（マージを実行しています）"],
    [{ request: "accepted", waiting: undefined }, "merged", "受け付けました（マージしました）"],
    [
      { request: "accepted", waiting: undefined },
      "rejected",
      "受け付けました（GitHub がマージを拒否しました。ブランチの保護ルールや競合を確認してください）",
    ],
    [{ request: "accepted", waiting: "CI_PENDING" }, undefined, "受け付けました（CI の完了を待っています）"],
  ] as const)("Merge の結果を自動マージの行に表示する", (merge, mergeOutcome, text) => {
    const body = authorizationComment({ status: "allowed", reason: "AUTHORIZED", merge, mergeOutcome });
    expect(body).toContain(`| 自動マージ | ${text} |`);
  });

  it.each([
    [{ request: "accepted", waiting: "DRAFT" }, undefined, "## Draft を解除するとマージできます"],
    [{ request: "accepted", waiting: "CI_PENDING" }, undefined, "## CI の完了を待っています"],
    [{ request: "accepted", waiting: undefined }, undefined, "## マージできます"],
    [{ request: "none" }, undefined, "## マージできます"],
    [{ request: "accepted", waiting: undefined }, "merged", "## マージしました"],
    [{ request: "accepted", waiting: undefined }, "rejected", "## マージできませんでした"],
  ] as const)("認可が通った PR の見出しに自動マージの状況を反映する", (merge, mergeOutcome, heading) => {
    const body = authorizationComment({ status: "allowed", reason: "AUTHORIZED", merge, mergeOutcome });
    expect(body).toContain(`${heading}\n`);
  });

  it("認可されていない PR の見出しは自動マージの待機に影響されない", () => {
    const body = authorizationComment({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      merge: { request: "accepted", waiting: "AUTHORIZATION" },
    });
    expect(body).toContain("## まだマージできません\n");
  });

  it("利用者向けの文に App の名前を含めない", () => {
    const body = authorizationComment({ status: "not_applicable", reason: "NO_CONTENT_CHANGES" });
    expect(body.replace("<!-- boarding:authorization -->", "")).not.toContain("boarding");
  });

  it.each([
    [{ status: "allowed", reason: "AUTHORIZED" }, "## マージできます"],
    [{ status: "waiting", reason: "EDITOR_APPROVAL_MISSING" }, "## まだマージできません"],
    [{ status: "rejected", reason: "INVALID_PROFILE" }, "## マージできません"],
    [{ status: "error", reason: "API_ERROR" }, "## 確認できませんでした"],
    [{ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, "## 記事以外の変更です"],
  ] as const)("状態を伝える見出しを表示する", (result, heading) => {
    expect(authorizationComment(result)).toContain(`${heading}\n`);
  });

  it("長い一覧を件数で省略しコメント上限内に収める", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `${String(i)}${"`|".repeat(150)}`);
    const commits = paths.map((sha) => ({
      sha,
      authorId: 1,
      authorEmail: null,
      committerId: 1,
      committerLogin: "alice",
      signature: null,
    }));
    const body = authorizationComment({
      status: "rejected",
      reason: "NON_CONTENT_CHANGE_FORBIDDEN",
      facts: { authorRoots: paths, otherPaths: paths, invalidCommits: commits },
      management: { mode: "offboarding", targets: paths.map((login) => ({ type: "user", login })) },
    });
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body.match(/…ほか \d+ 件/g)?.length).toBeGreaterThanOrEqual(4);
    expect(body).toContain("</details>");
  });

  it("不完全な取得の案内で差分以外の情報にも触れる", () => {
    const body = authorizationComment({ status: "error", reason: "INCOMPLETE_DATA" });
    expect(body).toContain("差分・コミット・所属情報");
    expect(body).toContain("再実行");
  });

  it("YAML サイズ超過時の修正方法を表示する", () => {
    const body = authorizationComment({ status: "error", reason: "YAML_SIZE_LIMIT" });
    expect(body).toContain("16 KiB");
    expect(body).toContain("64 KiB");
  });

  it("profile の不正を修正する方法を表示する", () => {
    const body = authorizationComment({ status: "rejected", reason: "INVALID_PROFILE" });
    expect(body).toContain("profile.yaml");
    expect(body).toContain("website");
  });

  it("対象外ファイルと修正方法を表示し個人メールを伏せる", () => {
    const body = authorizationComment({ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN", facts });
    expect(body).toContain("scripts/test.sh");
    expect(body).toContain("git restore");
    expect(body).toContain("Issue");
    expect(body).toContain("Settings → Emails");
    expect(body).toContain("123+alice@users.noreply.github.com");
    expect(body).not.toContain("person@example.com");
  });
});

describe("確認事項の表示", () => {
  const applicable = { authorRoots: ["alice"], otherPaths: [], invalidCommits: [] };
  const waiting = (consent: EvaluationResult["consent"]): EvaluationResult => ({
    status: "waiting",
    reason: "CONSENT_MISSING",
    facts: applicable,
    consent,
  });

  it("すべてチェック済みなら表に示し、警告は出さない", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      facts: applicable,
      consent: { state: "agreed" },
    });
    expect(body).toContain("| 確認事項 | 3 項目すべてチェック済み |");
    expect(body).not.toContain("確認事項のチェックが完了していません");
  });

  it("未チェックの項目を理由に挙げ、PR 作成者本人がチェックするよう案内する", () => {
    const body = authorizationComment(waiting({ state: "unchecked", missing: consentLabels.slice(1) }));
    expect(body).toContain("| 確認事項 | チェックされていない項目があります |");
    expect(body).toContain("> [!WARNING]\n> **確認事項のチェックが完了していません**");
    expect(body).toContain(
      `> 理由: 未チェックの項目があります（「${consentLabels[1] ?? ""}」、「${consentLabels[2] ?? ""}」）`
    );
    expect(body).not.toContain(`「${consentLabels[0] ?? ""}」`);
    expect(body).toContain("> PR 作成者本人が PR 本文の確認事項を読み、チェックを入れてください。");
    expect(body).toContain("## まだマージできません");
  });

  it("本人以外がチェックした場合は外して入れ直すよう案内する", () => {
    const body = authorizationComment(waiting({ state: "not_author" }));
    expect(body).toContain("| 確認事項 | PR 作成者のチェックを確認できません |");
    expect(body).toContain("> 理由: チェックを入れたのが PR 作成者であることを確認できませんでした");
    expect(body).toContain("> PR 作成者本人が、3 つのチェックを外して入れ直してください。");
  });

  it.each([
    ["invalid", "チェック欄の形式がテンプレートと異なります", "テンプレートの行は書き換えず"],
    ["history_unavailable", "PR 本文の編集履歴を確認できませんでした", "チェックを外して入れ直してください"],
  ] as const)("状態 %s の理由と直し方を表示する", (state, reason, action) => {
    const body = authorizationComment(waiting({ state }));
    expect(body).toContain(`> 理由: ${reason}`);
    expect(body).toContain(action);
  });

  it("authors/ を変更しない PR には表示しない", () => {
    const body = authorizationComment({
      status: "not_applicable",
      reason: "NO_CONTENT_CHANGES",
      facts: { authorRoots: [], otherPaths: [], invalidCommits: [] },
      consent: { state: "unchecked", missing: consentLabels },
    });
    expect(body).not.toContain("確認事項");
  });

  it("CONSENT_MISSING の状態を表と案内に表示する", () => {
    const body = authorizationComment(waiting({ state: "invalid" }));
    expect(body).toContain("| 状態 | PR 本文の確認事項のチェックが完了していません（` CONSENT_MISSING `） |");
    expect(body).toContain("> [!IMPORTANT]");
  });
});

describe("closedComment", () => {
  it.each([
    [true, "> この PR はマージされました。"],
    [false, "> この PR は閉じられました。再び開くともう一度確認を行います。"],
  ])("Merge 済み %s の最終状態を、目印から始まる短い本文で示す", (merged, line) => {
    expect(closedComment(merged)).toBe(`<!-- boarding:authorization -->\n> [!NOTE]\n${line}`);
  });
});

describe("check-run", () => {
  describe("Check Run の文面", () => {
    it.each([
      [{ status: "allowed", reason: "AUTHORIZED" }, "authors/ の変更に問題はありません"],
      [{ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, "authors/ の変更はありません"],
      [{ status: "waiting", reason: "EDITOR_APPROVAL_MISSING" }, "Editor の Approve が必要です"],
      [{ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" }, "authors/ 以外の変更が含まれています"],
      [{ status: "error", reason: "API_ERROR" }, "GitHub の情報を取得できませんでした"],
    ] as const)("%o の文言と管理コメントへの案内を返す", (result, title) => {
      const output = checkOutput(result);
      expect(output.title).toBe(title);
      expect(output.summary).toContain("PR の管理コメント");
    });

    it("確認中は状態を伝えて完了を待つよう案内し管理コメントを参照しない", () => {
      const output = checkOutput({ status: "waiting", reason: "EVALUATING" });
      expect(output.title).toBe("変更内容を確認しています");
      expect(output.summary).toBe("変更内容を確認しています。完了までしばらくお待ちください。");
      expect(output.summary).not.toContain("管理コメント");
    });

    it.each(["API_ERROR", "INCOMPLETE_DATA"] as const)("%s は再実行を案内する", (reason) => {
      expect(checkOutput({ status: "error", reason }).summary).toContain("再実行");
    });

    it("authors/ を変更していない PR には通常のレビューを案内する", () => {
      expect(checkOutput({ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }).summary).toContain(
        "通常のレビュー"
      );
    });

    it("対象外ファイルの対処を示す", () => {
      const output = checkOutput({ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" });
      expect(output.summary).toContain("`authors/` 以外の変更を PR から取り除いて push");
    });
  });
});
