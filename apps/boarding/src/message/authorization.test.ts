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
    expect(body).toContain("コミットの本人確認: コミットがありません");
    expect(body).not.toContain("コミットの本人確認: 一致");
  });

  it("モードを確認できなかった場合は通常認可と表示しない", () => {
    expect(authorizationComment({ status: "error", reason: "API_ERROR" })).toContain("モード: 確認できませんでした");
    expect(authorizationComment({ status: "error", reason: "API_ERROR", management: { mode: "none" } })).toContain(
      "モード: 通常の認可"
    );
  });

  it("管理対象と承認者が未確認の場合はなしと区別する", () => {
    const body = authorizationComment({
      status: "rejected",
      reason: "OFFBOARDING_INVALID_CHANGES",
      management: { mode: "offboarding" },
    });
    expect(body).toContain("管理モードの対象: 確認できませんでした");
    expect(body).toContain("管理モードの承認者: 確認できませんでした");
  });

  it("管理対象と承認者の domain 値を表示する", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      management: {
        mode: "offboarding",
        targets: [
          { type: "user", login: "bob" },
          { type: "team", slug: "blog" },
        ],
        approvers: [{ person: { id: 2, login: "carol" }, orgRole: "admin", teams: {} }],
      },
    });
    expect(body).toContain("`bob`, `team:blog`");
    expect(body).toContain("`carol` (Owner)");
  });

  it("Org を照会していない人は未確認と表示する", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      details: { memberships: [{ person: { id: 1, login: "alice" }, orgRole: undefined, teams: {} }] },
    });
    expect(body).toContain("Org 未確認");
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
