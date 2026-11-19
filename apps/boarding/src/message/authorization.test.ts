import { describe, expect, it } from "vitest";

import { authorizationComment } from "./authorization.js";

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
  it.each([
    [{ status: "allowed", reason: "AUTHORIZED" }, "TIP"],
    [{ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, "NOTE"],
    [{ status: "waiting", reason: "EVALUATING" }, "IMPORTANT"],
    [{ status: "rejected", reason: "INVALID_PROFILE" }, "WARNING"],
    [{ status: "error", reason: "API_ERROR" }, "CAUTION"],
  ] as const)("状態に対応するアラートを表示する", (result, alert) => {
    expect(authorizationComment(result)).toContain(`> [!${alert}]`);
  });

  it("表の対象著者に含まれる縦線をエスケープする", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      facts: { authorRoots: ["a|b"], otherPaths: [], invalidCommits: [] },
    });
    expect(body).toContain("| 対象著者 | ` a\\|b ` |");
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
    expect(body).toContain("### 著者コンテンツ以外の変更\n\n- ` README.md `");
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
    expect(body).toContain("`- [ ] すべてのチェックが成功したら自動マージする`");
    expect(body).toContain("だけにしてからチェック");
    expect(body).not.toContain("チェックを外して入れ直して");
    expect(body).not.toContain("管理者に相談");
  });

  it.each(["INTERVENTION_QUORUM_MISSING", "OFFBOARDING_APPROVAL_MISSING"] as const)(
    "%s では承認者の案内を表示する",
    (reason) => {
      const body = authorizationComment({ status: "waiting", reason });
      expect(body).toContain("Approve を依頼してください");
      expect(body).not.toContain("対象著者を確認してください");
    }
  );

  it("コミットがない場合は本人確認が一致したと表示しない", () => {
    const body = authorizationComment({
      status: "rejected",
      reason: "COMMIT_IDENTITY_MISMATCH",
      facts: { authorRoots: [], otherPaths: [], invalidCommits: [] },
    });
    expect(body).toContain("| コミットの本人確認 | コミットがありません |");
  });

  it("モードを確認できなかった場合は通常認可と表示しない", () => {
    expect(authorizationComment({ status: "error", reason: "API_ERROR" })).toContain(
      "| モード | 確認できませんでした |"
    );
    expect(authorizationComment({ status: "error", reason: "API_ERROR", management: { mode: "none" } })).toContain(
      "| モード | 通常の認可 |"
    );
  });

  it("管理モードの申請が無効な理由を折りたたまずに表示する", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      management: { mode: "none", reason: "CONFLICT" },
    });
    expect(body).toContain("管理モードの申請: 無効（両方のモードは同時に申請できません）");
  });

  it("管理対象が未確認の場合はなしと区別する", () => {
    const body = authorizationComment({
      status: "rejected",
      reason: "OFFBOARDING_INVALID_CHANGES",
      management: { mode: "offboarding" },
    });
    expect(body).toContain("管理モードの対象: 確認できませんでした");
  });

  it("Intervention の対象をなしと表示しない", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      management: { mode: "intervention", targets: [] },
    });
    expect(body).not.toContain("管理モードの対象");
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

  it("Team の同意は Maintainer 個人ではなく Team の条件を表示する", () => {
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
    expect(body).toContain("` team:blog ` の Maintainer");
    expect(body).toContain("` bob `");
  });

  it("複数候補のうち 1 名に同意を求める", () => {
    const body = authorizationComment({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      details: { root: "alice", missing: { kind: "one", editors: [{ type: "user", login: "bob" }] } },
    });
    expect(body).toContain("必要な同意: 次のうち 1 名: ` bob `");
  });

  it("website の同意が不足しているときに Org Member Editor の同意を案内する", () => {
    const body = authorizationComment({
      status: "waiting",
      reason: "WEBSITE_MEMBER_CONSENT_MISSING",
      details: { root: "author" },
    });
    expect(body).toContain("Org Member Editor");
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
