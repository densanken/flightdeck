import { describe, expect, it } from "vitest";

import {
  buildConsents,
  changedRoots,
  editorKey,
  isOrgMember,
  approvedPeople,
  approvedReviewers,
  matches,
  splitEditors,
  uniqueEditors,
  websiteCandidate,
} from "./editors.js";

import type { AuthorRoot, Editor, Membership, Review } from "./editors.js";

const alice: Editor = { type: "user", login: "alice" };
const team: Editor = { type: "team", slug: "blog" };
const member: Membership = { person: { id: 1, login: "Alice" }, orgRole: null, teams: { blog: "member" } };
const root: AuthorRoot = { name: "alice", before: [alice, team], after: [alice, team], websiteAddedOrChanged: true };

describe("Editor と所属", () => {
  it("個人と Team を所属者に照合する", () => {
    expect(matches(alice, member)).toBe(true);
    expect(matches(team, member)).toBe(true);
    expect(matches({ type: "team", slug: "other" }, member)).toBe(false);
  });

  it("大文字を含む Editor と所属を照合して同意を作る", () => {
    const user: Editor = { type: "user", login: "ALICE" };
    const upperTeam: Editor = { type: "team", slug: "BLOG" };
    const maintainer: Membership = { ...member, teams: { blog: "maintainer" } };

    expect(buildConsents([maintainer], [user, upperTeam])).toEqual([
      { editor: user, actorId: 1, maintainer: false, orgMember: true },
      { editor: upperTeam, actorId: 1, maintainer: true, orgMember: true },
    ]);
  });

  it("Team の名前がオブジェクトのプロパティと重なっても非所属を同意にしない", () => {
    const editor: Editor = { type: "team", slug: "constructor" };
    const nonMember: Membership = { ...member, teams: {} };

    expect(matches(editor, nonMember)).toBe(false);
    expect(buildConsents([nonMember], [editor])).toEqual([]);
  });

  it("Team Member は Org Member として website の同意候補になる", () => {
    expect(isOrgMember(member)).toBe(true);
    expect(websiteCandidate(member, root)).toBe(true);
    expect(websiteCandidate(member, { ...root, websiteAddedOrChanged: false })).toBe(false);
    expect(isOrgMember({ ...member, teams: {} })).toBe(false);
  });

  it("複数ルートの同一 Editor を集約し同意を作る", () => {
    const editors = uniqueEditors([root, { ...root, name: "bob", before: [alice], after: [alice] }]);
    expect(editors).toEqual([alice, team]);
    expect(buildConsents([member], editors)).toEqual([
      { editor: alice, actorId: 1, maintainer: false, orgMember: true },
      { editor: team, actorId: 1, maintainer: false, orgMember: true },
    ]);
  });

  it("Editor の種類と大文字小文字を考慮して同一性と照会先を分ける", () => {
    expect(editorKey({ type: "user", login: "Alice" })).toBe(editorKey(alice));
    expect(editorKey({ type: "team", slug: "Blog" })).toBe(editorKey(team));
    expect(editorKey({ type: "user", login: "blog" })).not.toBe(editorKey(team));
    expect(splitEditors([alice, team])).toEqual({ users: ["alice"], teams: ["blog"] });
  });

  it("改名前と改名後のパスから変更されたルートを選ぶ", () => {
    const files = [{ path: "authors/bob/profile.yml", previousPath: "authors/alice/meta.yaml" }];
    expect(changedRoots(files, ["alice", "bob"], "meta")).toEqual(["alice"]);
    expect(changedRoots(files, ["alice", "bob"], "profile")).toEqual(["bob"]);
  });
});

describe("reviews", () => {
  const review = (overrides: Partial<Review>): Review => ({
    reviewerId: 2,
    state: "APPROVED",
    commitSha: "head",
    submittedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  describe("approvedReviewers", () => {
    it("承認後の COMMENTED は承認を取り消さない", () => {
      expect(
        approvedReviewers([review({}), review({ state: "COMMENTED", submittedAt: "2026-01-02T00:00:00Z" })], "head", 1)
      ).toEqual([2]);
    });

    it("変更要求後の COMMENTED は変更要求を取り消さない", () => {
      expect(
        approvedReviewers(
          [
            review({}),
            review({ state: "CHANGES_REQUESTED", submittedAt: "2026-01-02T00:00:00Z" }),
            review({ state: "COMMENTED", submittedAt: "2026-01-03T00:00:00Z" }),
          ],
          "head",
          1
        )
      ).toEqual([]);
    });

    it("日時の表記が異なっても新しい Review を優先する", () => {
      expect(
        approvedReviewers(
          [review({}), review({ state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00.500Z" })],
          "head",
          1
        )
      ).toEqual([]);
    });

    it("日時を判定できない Reviewer の承認を数えない", () => {
      expect(approvedReviewers([review({}), review({ submittedAt: "invalid" })], "head", 1)).toEqual([]);
    });

    it("同時刻の Review があるときは承認を数えない", () => {
      expect(approvedReviewers([review({}), review({ state: "CHANGES_REQUESTED" })], "head", 1)).toEqual([]);
    });

    it("最新 HEAD の最新 Review だけを数える", () => {
      expect(
        approvedReviewers(
          [
            review({ reviewerId: 2 }),
            review({ reviewerId: 2, state: "DISMISSED", submittedAt: "2026-01-02T00:00:00Z" }),
            review({ reviewerId: 3, commitSha: "old" }),
            review({ reviewerId: 4 }),
            review({ reviewerId: 1 }),
          ],
          "head",
          1
        )
      ).toEqual([4]);
    });
  });

  describe("有効な Reviewer", () => {
    it("作成者と Bot を除き ID ごとに一度だけ返す", () => {
      const reviews = [
        { ...review({ reviewerId: 1 }), login: "author" },
        { ...review({ reviewerId: 2 }), login: "alice" },
        { ...review({ reviewerId: 3 }), login: "bot", isBot: true },
        { ...review({ reviewerId: 2, state: "COMMENTED" }), login: "alice" },
      ];
      expect(approvedPeople(reviews, "head", 1)).toEqual([{ id: 2, login: "alice" }]);
    });
  });
});
