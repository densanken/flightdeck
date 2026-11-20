import { describe, expect, it } from "vitest";

import { authorizeRoot, invalidCommitIdentities } from "./authorization.js";

import type { RootAuthorization } from "./authorization.js";
import type { Consent, Editor } from "./editors.js";

const alice: Editor = { login: "alice", type: "user" };
const upperAlice: Editor = { login: "ALICE", type: "user" };
const bob: Editor = { login: "bob", type: "user" };
const carol: Editor = { login: "carol", type: "user" };
const team: Editor = { slug: "blog", type: "team" };
const consent = (editor: Editor, actorId: number, maintainer = false, orgMember = false): Consent => ({
  editor,
  actorId,
  maintainer,
  orgMember,
});
const root = (overrides: Partial<RootAuthorization>): RootAuthorization => ({
  before: [alice],
  after: [alice],
  authorId: 1,
  consents: [],
  websiteAddedOrChanged: false,
  ...overrides,
});

describe("authorizeRoot", () => {
  it.each([
    ["変更後の Editor が空", { after: [] }],
    ["変更前の Editor が空", { before: [] }],
    ["変更前の Editor が重複", { before: [alice, upperAlice] }],
  ])("%s の場合は拒否する", (_name, overrides) => {
    expect(authorizeRoot(root(overrides))).toMatchObject({ status: "rejected", reason: "INVALID_EDITORS" });
  });

  it("大文字小文字だけが異なる Editor の重複を拒否する", () => {
    expect(authorizeRoot(root({ after: [alice, { type: "user", login: "ALICE" }] })).reason).toBe("INVALID_EDITORS");
  });

  it("通常編集は既存 Editor の同意を要求する", () => {
    expect(authorizeRoot(root({})).status).toBe("waiting");
    expect(authorizeRoot(root({ consents: [consent(alice, 1)] })).status).toBe("allowed");
  });

  it("新規登録は PR 作成者自身が Editor であることを要求する", () => {
    expect(authorizeRoot(root({ before: null, after: [alice], consents: [consent(alice, 2)] })).reason).toBe(
      "INITIAL_AUTHOR_NOT_EDITOR"
    );
    expect(authorizeRoot(root({ before: null, after: [alice, bob], consents: [consent(alice, 1)] })).status).toBe(
      "allowed"
    );
  });

  it("未同意の削除対象だけを示す", () => {
    const result = authorizeRoot(root({ before: [alice, bob], after: [carol], consents: [consent(alice, 1)] }));
    expect(result).toMatchObject({ status: "waiting", reason: "EDITOR_APPROVAL_MISSING" });
    expect(result.details?.missing).toEqual({ kind: "all", editors: [bob] });
  });

  it("削除では削除される全員の同意を要求する", () => {
    const input = root({ before: [alice, bob], after: [carol], consents: [consent(alice, 1)] });
    expect(authorizeRoot(input).status).toBe("waiting");
    expect(authorizeRoot({ ...input, consents: [...input.consents, consent(bob, 2)] }).status).toBe("allowed");
  });

  it("Editor の移転は旧 Editor の同意だけで足りる", () => {
    const input = root({ after: [bob] });
    expect(authorizeRoot(input).status).toBe("waiting");
    expect(authorizeRoot({ ...input, consents: [consent(alice, 1)] }).status).toBe("allowed");
  });

  it("追加だけなら今の Editor 1 人の同意で足りる", () => {
    expect(authorizeRoot(root({ after: [alice, bob], consents: [consent(alice, 1)] })).status).toBe("allowed");
  });

  it("外部の PR 作成者が自分を追加するには今の Editor の同意が必要", () => {
    const input = root({ after: [alice, bob], authorId: 2, consents: [consent(bob, 2)] });
    expect(authorizeRoot(input)).toMatchObject({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      details: { missing: { kind: "one", editors: [alice] } },
    });
    expect(authorizeRoot({ ...input, consents: [...input.consents, consent(alice, 1)] }).status).toBe("allowed");
  });

  it.each([
    ["移転 Author A は A の Review で認可", [bob], 1, [consent(alice, 1)], "allowed"],
    ["移転 Author B は A の Review が必要", [bob], 2, [consent(bob, 2)], "waiting"],
    ["移転 Author B は A の Review で認可", [bob], 2, [consent(bob, 2), consent(alice, 1)], "allowed"],
    ["移転 Author C は A の Review が必要", [bob], 3, [], "waiting"],
    ["移転 Author C は A の Review で認可", [bob], 3, [consent(alice, 1)], "allowed"],
    ["追加 Author B は A の Review が必要", [alice, bob], 2, [consent(bob, 2)], "waiting"],
    ["追加 Author B は A の Review で認可", [alice, bob], 2, [consent(bob, 2), consent(alice, 1)], "allowed"],
    ["追加 Author C は A の Review で認可", [alice, bob], 3, [consent(alice, 1)], "allowed"],
  ])("%s", (_name, after, authorId, consents, status) => {
    expect(authorizeRoot(root({ after, authorId, consents })).status).toBe(status);
  });

  it.each([
    ["通常編集", [team], "waiting"],
    ["初回登録", null, "rejected"],
  ])("Team の非 Member による%sを許可しない", (_name, before, status) => {
    expect(authorizeRoot(root({ before, after: [team], consents: [] })).status).toBe(status);
  });

  it("初回登録の website にも Org Member Editor の同意を要求する", () => {
    const input = root({
      before: null,
      after: [alice, bob],
      authorId: 1,
      consents: [consent(alice, 1)],
      websiteAddedOrChanged: true,
    });
    expect(authorizeRoot(input)).toEqual({ status: "waiting", reason: "WEBSITE_MEMBER_CONSENT_MISSING" });
    expect(authorizeRoot({ ...input, consents: [...input.consents, consent(bob, 2, false, true)] }).status).toBe(
      "allowed"
    );
  });

  it("Team の追加は今の Editor の同意だけで足りる", () => {
    expect(authorizeRoot(root({ after: [alice, team], consents: [consent(alice, 1)] })).status).toBe("allowed");
  });

  it("Team の削除では Maintainer の同意を要求する", () => {
    const input = root({ before: [alice, team], after: [alice], consents: [consent(alice, 1), consent(team, 2)] });
    expect(authorizeRoot(input).reason).toBe("TEAM_MAINTAINER_REQUIRED");
    expect(authorizeRoot({ ...input, consents: [consent(alice, 1), consent(team, 2, true)] }).status).toBe("allowed");
  });

  it("削除だけなら削除対象の同意で足りる", () => {
    expect(authorizeRoot(root({ before: [alice, bob], after: [bob], consents: [consent(alice, 1)] })).status).toBe(
      "allowed"
    );
  });

  it("website の追加には Org Member Editor の同意を要求する", () => {
    const input = root({ consents: [consent(alice, 1)], websiteAddedOrChanged: true });
    expect(authorizeRoot(input)).toEqual({ status: "waiting", reason: "WEBSITE_MEMBER_CONSENT_MISSING" });
    expect(authorizeRoot({ ...input, consents: [consent(alice, 1, false, true)] }).status).toBe("allowed");
  });
});

describe("管理モードの同意", () => {
  it.each(["intervention", "offboarding"] as const)("%s は追加対象の同意を要求しない", (mode) => {
    const input = root({ before: [alice], after: [bob, team], mode });
    expect(authorizeRoot(input).status).toBe("allowed");
    expect(authorizeRoot({ ...input, after: [] }).reason).toBe("INVALID_EDITORS");
  });

  it("Offboarding で残る Editor がいる後任追加は残る Editor の同意を要求する", () => {
    const input = root({
      before: [alice, bob],
      after: [bob, team],
      mode: "offboarding",
    });
    expect(authorizeRoot(input)).toMatchObject({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      details: { missing: { kind: "one", editors: [bob] } },
    });
    expect(authorizeRoot({ ...input, consents: [consent(alice, 1)] }).status).toBe("waiting");
    expect(authorizeRoot({ ...input, consents: [consent(bob, 2)] }).status).toBe("allowed");
  });

  it("Intervention は website の特別認可を省略しない", () => {
    const input = root({ mode: "intervention", websiteAddedOrChanged: true });
    expect(authorizeRoot(input)).toEqual({ status: "waiting", reason: "WEBSITE_MEMBER_CONSENT_MISSING" });
    expect(authorizeRoot({ ...input, consents: [consent(alice, 2, false, true)] }).status).toBe("allowed");
  });

  it("Intervention でも新規登録の作成者を確認する", () => {
    expect(authorizeRoot(root({ mode: "intervention", before: null, after: [alice], consents: [] })).reason).toBe(
      "INITIAL_AUTHOR_NOT_EDITOR"
    );
    expect(
      authorizeRoot(root({ mode: "intervention", before: null, after: [alice, bob], consents: [consent(alice, 1)] }))
        .status
    ).toBe("allowed");
  });
});

describe("commit-identity", () => {
  const commit = { sha: "abc", authorId: 1, committerId: 1, committerLogin: "alice", signature: null };
  const webFlow = {
    ...commit,
    committerId: 2,
    committerLogin: "web-flow",
    signature: { isValid: true, wasSignedByGitHub: true },
  };

  describe("invalidCommitIdentities", () => {
    it("作者とコミッターが PR 作成者なら署名なしでも許可する", () => {
      expect(invalidCommitIdentities([commit], 1)).toEqual([]);
    });

    it("GitHub が署名した有効な web-flow のコミットを許可する", () => {
      expect(invalidCommitIdentities([webFlow], 1)).toEqual([]);
    });

    it.each([
      { ...commit, authorId: null },
      { ...commit, authorId: 2 },
      { ...commit, committerId: null },
      { ...commit, committerId: 2 },
      { ...webFlow, authorId: 2 },
      { ...webFlow, committerId: null },
      { ...webFlow, committerLogin: "other" },
      { ...webFlow, signature: null },
      { ...webFlow, signature: { isValid: false, wasSignedByGitHub: true } },
      { ...webFlow, signature: { isValid: true, wasSignedByGitHub: false } },
    ])("作者またはコミッターを確認できないコミットを拒否する %#", (invalid) => {
      expect(invalidCommitIdentities([commit, invalid], 1)).toEqual([invalid]);
    });
  });
});
