import { describe, expect, it } from "vitest";

import {
  buildConsents,
  changedRoots,
  editorKey,
  isOrgMember,
  matches,
  splitEditors,
  uniqueEditors,
  websiteCandidate,
} from "./editors.js";

import type { AuthorRoot, Editor, Membership } from "./editors.js";

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
