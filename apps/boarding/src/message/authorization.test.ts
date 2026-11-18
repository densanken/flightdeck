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

  it("Org を照会していない人は未確認と表示する", () => {
    const body = authorizationComment({
      status: "allowed",
      reason: "AUTHORIZED",
      details: { memberships: [{ login: "alice", orgRole: undefined, teams: {} }] },
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
