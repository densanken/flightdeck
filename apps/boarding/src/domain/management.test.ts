import { describe, expect, it } from "vitest";

import {
  interventionLabel,
  managementApproval,
  managementRequest,
  memberRequest,
  needsBodyHistory,
  offboardingChangeViolation,
  offboardingLabel,
  offboardingTargetViolation,
  removedEditors,
  rootManagementMode,
} from "./management.js";
import { mergeLabel } from "./merge-request.js";

import type { AuthorRoot, Membership } from "./editors.js";

const checked = (label: string) => `- [x] ${label}`;
const membership = (id: number, orgRole: Membership["orgRole"]): Membership => ({
  person: { id, login: `user${String(id)}` },
  orgRole,
  teams: {},
});

const interventionQuorum = (members: Membership[], authorId: number) =>
  managementApproval(members, authorId, "intervention") === undefined;
const offboardingApproval = (members: Membership[], authorId: number) =>
  managementApproval(members, authorId, "offboarding") === undefined;

describe("管理モードの申請", () => {
  it.each([interventionLabel, offboardingLabel, mergeLabel])("チェックした欄 %s に対して履歴を取得する", (label) => {
    expect(needsBodyHistory(checked(label))).toBe(true);
    expect(needsBodyHistory(`- [ ] ${label}`)).toBe(false);
  });

  it.each([
    [interventionLabel, "intervention"],
    [offboardingLabel, "offboarding"],
  ] as const)("作成者による %s を受理する", (label, mode) => {
    const body = checked(label);
    expect(managementRequest(body, [{ body, editorId: 1 }], 1)).toEqual({ mode });
    expect(managementRequest(body, [{ body, editorId: 2 }], 1)).toMatchObject({ reason: "NOT_AUTHOR" });
    expect(managementRequest(body, null, 1)).toMatchObject({ reason: "HISTORY_UNAVAILABLE" });
    expect(managementRequest(body, [{ body: "別の本文", editorId: 1 }], 1)).toMatchObject({
      reason: "HISTORY_UNAVAILABLE",
    });
  });

  it("作成者が Org に所属しない申請を無効にする", () => {
    const request = { mode: "intervention" } as const;
    expect(memberRequest(request, null)).toEqual({ mode: "none", reason: "NOT_MEMBER" });
    expect(memberRequest(request, "member")).toEqual(request);
  });

  it("重複や不正なチェック欄を無効にする", () => {
    const body = checked(interventionLabel);
    expect(managementRequest(`${body}\n${body}`, null, 1)).toMatchObject({ reason: "INVALID_CHECKBOX" });
    expect(managementRequest(body.replace("[x]", "[o]"), null, 1)).toMatchObject({ reason: "INVALID_CHECKBOX" });
  });

  it("両方の申請を無効にする", () => {
    const body = `${checked(interventionLabel)}\n${checked(offboardingLabel)}`;
    expect(managementRequest(body, [{ body, editorId: 1 }], 1)).toMatchObject({ reason: "CONFLICT" });
  });

  it("最後にチェックした編集者を確認し、チェック解除で申請を取り消す", () => {
    const body = checked(interventionLabel);
    const unchecked = `- [ ] ${interventionLabel}`;
    expect(
      managementRequest(
        body,
        [
          { body, editorId: 1 },
          { body: unchecked, editorId: 1 },
          { body, editorId: 2 },
        ],
        1
      )
    ).toMatchObject({ reason: "NOT_AUTHOR" });
    expect(managementRequest(unchecked, null, 1)).toEqual({ mode: "none" });
  });
});

describe("管理モードの承認", () => {
  it("Intervention は Owner と別の Member 3 人を必要とする", () => {
    const reviewers = [membership(2, "admin"), membership(3, "member"), membership(4, "member")];
    expect(interventionQuorum(reviewers, 1)).toBe(false);
    expect(interventionQuorum([...reviewers, membership(5, "member")], 1)).toBe(true);
    expect(
      interventionQuorum(
        [membership(2, "member"), membership(3, "member"), membership(4, "member"), membership(5, "member")],
        1
      )
    ).toBe(false);
  });

  it("作成者と重複を除き、2 人目の Owner は Member として数える", () => {
    const reviewers = [
      membership(1, "admin"),
      membership(2, "admin"),
      membership(3, "admin"),
      membership(3, "admin"),
      membership(4, "member"),
    ];
    expect(interventionQuorum(reviewers, 1)).toBe(false);
    expect(interventionQuorum([...reviewers, membership(5, "member")], 1)).toBe(true);
  });

  it("Offboarding の承認には Owner だけを数える", () => {
    const reviewers = [membership(1, "admin"), membership(2, "member"), membership(3, "admin")];
    expect(managementApproval(reviewers, 1, "offboarding")).toBeUndefined();
    expect(managementApproval(reviewers.slice(0, 2), 1, "offboarding")).toBe("OFFBOARDING_APPROVAL_MISSING");
  });

  it("Offboarding は作成者以外の Owner を必要とする", () => {
    expect(offboardingApproval([membership(1, "admin"), membership(2, "member")], 1)).toBe(false);
    expect(offboardingApproval([membership(1, "member"), membership(2, "admin")], 1)).toBe(true);
  });
});

describe("offboarding", () => {
  const root: AuthorRoot = {
    name: "alice",
    before: [
      { type: "user", login: "alice" },
      { type: "user", login: "bob" },
    ],
    after: [{ type: "user", login: "alice" }],
    websiteAddedOrChanged: false,
  };
  const file = { path: "authors/alice/meta.yaml" };
  const metaKeys = [{ before: ["editors"], after: ["editors"] }];
  const member = (orgRole: Membership["orgRole"]): Membership => ({
    person: { id: 2, login: "bob" },
    orgRole,
    teams: {},
  });

  describe("Offboarding の差分", () => {
    it("meta の editors の変更を受け入れる", () => {
      expect(offboardingChangeViolation([file], metaKeys)).toBeUndefined();
      expect(removedEditors([root])).toEqual([{ type: "user", login: "bob" }]);
    });

    it("他のファイルとの混在を拒否する", () => {
      expect(offboardingChangeViolation([file, { path: "authors/alice/post.md" }], metaKeys)).toBe(
        "OFFBOARDING_INVALID_CHANGES"
      );
    });

    it.each([
      { before: null, after: ["editors"] },
      { before: ["editors"], after: null },
      { before: ["editors"], after: ["editors", "extra"] },
      { before: ["editors", "extra"], after: ["editors"] },
      { before: ["editors", "extra"], after: ["editors", "extra"] },
    ])("前後いずれかのキーが editors のみでなければ拒否する", (keys) => {
      expect(offboardingChangeViolation([file], [keys])).toBe("OFFBOARDING_INVALID_CHANGES");
    });

    it("削除のない著者には通常の同意を要求する", () => {
      const other: AuthorRoot = {
        name: "carol",
        before: [{ type: "user", login: "carol" }],
        after: [
          { type: "user", login: "carol" },
          { type: "user", login: "dave" },
        ],
        websiteAddedOrChanged: false,
      };
      expect(rootManagementMode(root, "offboarding")).toBe("offboarding");
      expect(rootManagementMode(other, "offboarding")).toBeUndefined();
    });

    it("削除対象がなければ拒否する", () => {
      expect(offboardingTargetViolation([{ ...root, after: root.before ?? [] }], [])).toBe(
        "OFFBOARDING_INVALID_CHANGES"
      );
    });

    it("削除対象は非 Member の個人だけに限定する", () => {
      const team: AuthorRoot = { ...root, before: [...root.after, { type: "team", slug: "blog" }] };
      expect(offboardingTargetViolation([root], [member(null)])).toBeUndefined();
      expect(offboardingTargetViolation([team], [])).toBe("OFFBOARDING_INVALID_TARGET");
      expect(offboardingTargetViolation([root], [member("member")])).toBe("OFFBOARDING_INVALID_TARGET");
    });
  });
});
