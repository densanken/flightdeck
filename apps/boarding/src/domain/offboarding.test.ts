import { describe, expect, it } from "vitest";

import {
  offboardingChangeViolation,
  offboardingTargetViolation,
  removedEditors,
  rootManagementMode,
} from "./offboarding.js";

import type { AuthorRoot, Membership } from "./editors.js";

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
    expect(offboardingTargetViolation([{ ...root, after: root.before ?? [] }], [])).toBe("OFFBOARDING_INVALID_CHANGES");
  });

  it("削除対象は非 Member の個人だけに限定する", () => {
    const team: AuthorRoot = { ...root, before: [...root.after, { type: "team", slug: "blog" }] };
    expect(offboardingTargetViolation([root], [member(null)])).toBeUndefined();
    expect(offboardingTargetViolation([team], [])).toBe("OFFBOARDING_INVALID_TARGET");
    expect(offboardingTargetViolation([root], [member("member")])).toBe("OFFBOARDING_INVALID_TARGET");
  });
});
