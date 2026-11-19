import { describe, expect, it, vi } from "vitest";

import { EvaluateUseCaseImpl } from "./impl.js";
import * as authorization from "../../domain/authorization.js";
import { BoardingError } from "../../errors.js";

import type { EvaluateGateway, PullRequestData, RootFiles } from "./dependencies.js";
import type { Editor, Membership } from "../../domain/editors.js";
import type { ManagementRequest } from "../../domain/management.js";

const blank: RootFiles = { metaYaml: null, metaYml: null, profileYaml: null, profileYml: null };
const author = { id: 1, login: "alice" };
const bob = { id: 2, login: "bob" };
const carol = { id: 3, login: "carol" };
const review = (person: typeof bob) => ({
  reviewerId: person.id,
  login: person.login,
  state: "APPROVED" as const,
  submittedAt: "2026-01-01T00:00:00Z",
  commitSha: "head",
});
const pr: PullRequestData = {
  mergeData: { draft: false, body: "", ci: null },
  state: "OPEN",
  baseBranch: "main",
  baseSha: "base",
  headSha: "head",
  author,
  files: [{ path: "authors/alice/post.md" }],
  commits: [{ sha: "head", authorId: 1, committerId: 1, committerLogin: "alice", signature: null }],
  reviews: [],
  isCrossRepository: false,
  headRepositoryId: 1,
  baseRoots: ["alice"],
};
const meta = (editors: string[] | null): RootFiles => ({
  ...blank,
  metaYaml: editors === null ? null : JSON.stringify(editors),
});
const readEditors = (files: RootFiles): Editor[] | null => {
  const text = files.metaYaml ?? files.metaYml;
  if (text === null) return null;
  return (JSON.parse(text) as string[]).map((key) =>
    key.startsWith("team:") ? { type: "team", slug: key.slice(5) } : { type: "user", login: key }
  );
};
const readWebsite = (files: RootFiles): string | null => {
  const text = files.profileYaml ?? files.profileYml;
  return text === null ? null : ((JSON.parse(text) as { website?: string }).website ?? null);
};
const pair = (before: string[] | null, after: string[]) => ({ before: meta(before), after: meta(after) });
const authorMembership: Membership = { person: author, orgRole: "member", teams: {} };
const defaultMembers: Membership[] = [
  authorMembership,
  { person: bob, orgRole: "member", teams: {} },
  { person: carol, orgRole: "member", teams: {} },
];
const setup = (
  options: {
    pr?: PullRequestData;
    files?: Record<string, { before: RootFiles; after: RootFiles }>;
    members?: Membership[];
    readMetaKeys?: (files: RootFiles) => string[] | null;
  } = {}
) => {
  const value = options.pr ?? pr;
  const members = options.members ?? defaultMembers;
  const gateway: EvaluateGateway = {
    files: vi.fn().mockImplementation((_base: string, _head: string, roots: string[]) =>
      Promise.resolve(
        Object.entries(options.files ?? { alice: pair(["alice"], ["alice"]) })
          .filter(([root]) => roots.includes(root))
          .map(([root, pair]) => ({ root, ...pair }))
      )
    ),
    validateEditors: vi
      .fn()
      .mockImplementation((users: string[]) =>
        Promise.resolve(
          users
            .map((login) => members.find((member) => member.person.login.toLowerCase() === login.toLowerCase())?.person)
            .filter(Boolean)
        )
      ),
    teamMemberships: vi
      .fn()
      .mockImplementation((people: { id: number }[]) =>
        Promise.resolve(
          members
            .filter((member) => people.some((person) => person.id === member.person.id))
            .map((member) => ({ ...member, orgRole: undefined, teams: { ...member.teams } }))
        )
      ),
    orgMembership: vi
      .fn()
      .mockImplementation((person: { id: number }) =>
        Promise.resolve(members.find((member) => member.person.id === person.id)?.orgRole ?? null)
      ),
  };
  const parseEditors = vi.fn(readEditors);
  const parseWebsite = vi.fn(readWebsite);
  return {
    gateway,
    parseEditors,
    parseWebsite,
    run: (snapshot: PullRequestData = value, request: ManagementRequest = { mode: "none" }) =>
      new EvaluateUseCaseImpl({
        gateway,
        readEditors: parseEditors,
        readWebsite: parseWebsite,
        readMetaKeys:
          options.readMetaKeys ?? ((files) => (files.metaYaml === null && files.metaYml === null ? null : ["editors"])),
      }).execute(snapshot, request),
  };
};

describe("EvaluateUseCaseImpl", () => {
  it("大文字を含む個人 Editor と Reviewer の同意を照合する", async () => {
    const { run, parseEditors } = setup({ pr: { ...pr, reviews: [review(bob)] } });
    parseEditors.mockReturnValue([{ type: "user", login: "BOB" }]);

    expect(await run()).toMatchObject({ status: "allowed", reason: "AUTHORIZED" });
  });

  it.each([
    ["コミットの本人確認が一致しない", "mismatch", "rejected", "COMMIT_IDENTITY_MISMATCH"],
    ["コミットがない", "empty", "rejected", "COMMIT_IDENTITY_MISMATCH"],
    ["profile が不正", "profile", "rejected", "INVALID_PROFILE"],
    ["YAML のサイズが上限を超える", "size", "error", "YAML_SIZE_LIMIT"],
    ["Editor の形式が不正", "metadata", "rejected", "INVALID_EDITORS"],
  ])("%s 場合は対応する結果を返す", async (_label, failure, status, reason) => {
    const badCommit = { sha: "head", authorId: 2, committerId: 1, committerLogin: "alice", signature: null };
    const snapshot = {
      ...pr,
      files: failure === "profile" ? [{ path: "authors/alice/profile.yaml" }] : pr.files,
      commits: failure === "mismatch" ? [badCommit] : failure === "empty" ? [] : pr.commits,
    };
    const { run, gateway, parseWebsite } = setup({ pr: snapshot });
    if (failure === "profile")
      parseWebsite.mockImplementation(() => {
        throw new BoardingError("INVALID_PROFILE", "invalid");
      });
    if (failure === "size") vi.mocked(gateway.files).mockRejectedValue(new BoardingError("YAML_SIZE_LIMIT", "large"));
    if (failure === "metadata")
      vi.mocked(gateway.validateEditors).mockRejectedValue(new BoardingError("INVALID_METADATA", "invalid"));

    const result = await run();
    expect(result).toMatchObject({ status, reason });
    if (failure === "mismatch" || failure === "empty") {
      expect(result.facts?.invalidCommits).toEqual(failure === "mismatch" ? [badCommit] : []);
    }
  });

  it("新しい HEAD では以前の承認が失効する", async () => {
    const value = { ...pr, reviews: [review(bob)] };
    const { run } = setup({ pr: value, files: { alice: pair(["bob"], ["bob"]) } });
    expect((await run()).status).toBe("allowed");
    expect((await run({ ...value, headSha: "new" })).status).toBe("waiting");
  });

  it("Team 脱退後の再評価では以前の同意を認可に使わない", async () => {
    const members: Membership[] = [authorMembership, { person: bob, orgRole: "member", teams: { blog: "member" } }];
    const { run, gateway } = setup({
      pr: { ...pr, reviews: [review(bob)] },
      files: { alice: pair(["team:blog"], ["team:blog"]) },
      members,
    });
    expect((await run()).status).toBe("allowed");
    vi.mocked(gateway.teamMemberships).mockImplementation((people) =>
      Promise.resolve(people.map((person) => ({ person, orgRole: undefined, teams: { blog: null } })))
    );
    expect((await run()).status).toBe("waiting");
  });

  it("profile が変更されたルートのみ取得する", async () => {
    const value = {
      ...pr,
      files: [
        { path: "authors/alice/profile.yml", previousPath: "authors/alice/profile.yaml" },
        { path: "authors/bob/post.md" },
      ],
      baseRoots: ["alice", "bob"],
      reviews: [review(bob)],
    };
    const { run, gateway } = setup({
      pr: value,
      files: { alice: pair(["alice"], ["alice"]), bob: pair(["bob"], ["bob"]) },
    });
    await run();
    expect(gateway.files).toHaveBeenCalledWith("base", "head", ["alice", "bob"], ["alice"], []);
  });

  it("base だけで Editor が追加された通常編集は最新 base の Editor で認可する", async () => {
    const files = { alice: pair(["alice", "bob"], ["alice"]) };
    const { run, gateway, parseEditors } = setup({ files });
    expect((await run()).status).toBe("allowed");
    expect(gateway.files).toHaveBeenCalledWith("base", "head", ["alice"], [], []);
    expect(parseEditors).toHaveBeenCalledTimes(1);
  });

  it("authors がない base から新しい AuthorRoot を登録する", async () => {
    const value = { ...pr, baseRoots: [], files: [{ path: "authors/alice/meta.yaml" }] };
    expect((await setup({ pr: value, files: { alice: pair(null, ["alice"]) } }).run()).status).toBe("allowed");
  });

  it("Author の同意で足りる Team 編集は多数の無関係な Approve を照会しない", async () => {
    const reviews = Array.from({ length: 150 }, (_, index) =>
      review({ id: index + 10, login: `reviewer${String(index)}` })
    );
    const members: Membership[] = [{ person: author, orgRole: "member", teams: { blog: "member" } }];
    const { run, gateway } = setup({
      pr: { ...pr, reviews },
      files: { alice: pair(["team:blog"], ["team:blog"]) },
      members,
    });
    expect((await run()).status).toBe("allowed");
    expect(gateway.teamMemberships).toHaveBeenCalledOnce();
    expect(gateway.teamMemberships).toHaveBeenCalledWith([author], ["blog"]);
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("Team の同意が不足していても多数の無関係な Approve の中から同意を確認する", async () => {
    const reviews = [
      review(bob),
      ...Array.from({ length: 150 }, (_, index) => review({ id: index + 10, login: `reviewer${String(index)}` })),
    ];
    const members: Membership[] = [
      authorMembership,
      { person: bob, orgRole: "member", teams: { blog: "member" } },
      ...reviews.slice(1).map((entry) => ({
        person: { id: entry.reviewerId, login: entry.login },
        orgRole: null,
        teams: { blog: null },
      })),
    ];
    const { run, gateway } = setup({
      pr: { ...pr, reviews },
      files: { alice: pair(["team:blog"], ["team:blog"]) },
      members,
    });
    expect((await run()).status).toBe("allowed");
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("新規登録の拒否が確定していれば他のルートの Reviewer は照会しない", async () => {
    const value = {
      ...pr,
      files: [{ path: "authors/bob/post.md" }, { path: "authors/new/meta.yaml" }],
      baseRoots: ["bob"],
      reviews: [review(bob)],
    };
    const { run, gateway } = setup({
      pr: value,
      files: { bob: pair(["bob"], ["bob"]), new: pair(null, ["carol"]) },
    });
    expect(await run()).toMatchObject({
      status: "rejected",
      reason: "INITIAL_AUTHOR_NOT_EDITOR",
    });
    expect(gateway.teamMemberships).toHaveBeenCalledOnce();
  });

  it("Author が同意済みのルートに関係する Reviewer を他のルートのために照会しない", async () => {
    const value = {
      ...pr,
      files: [{ path: "authors/alice/post.md" }, { path: "authors/bob/post.md" }],
      baseRoots: ["alice", "bob"],
      reviews: [review(bob), review(carol)],
    };
    const members: Membership[] = [
      { person: author, orgRole: "member", teams: { blog: "member" } },
      ...defaultMembers.slice(1),
    ];
    const { run, gateway } = setup({
      pr: value,
      files: { alice: pair(["team:blog"], ["team:blog"]), bob: pair(["bob"], ["bob"]) },
      members,
    });
    expect((await run()).status).toBe("allowed");
    expect(gateway.teamMemberships).toHaveBeenNthCalledWith(2, [bob], []);
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("website の同意候補のみ Org の所属を確認する", async () => {
    const files = {
      alice: {
        before: { ...meta(["alice", "bob"]), profileYaml: null },
        after: { ...meta(["alice", "bob"]), profileYaml: JSON.stringify({ website: "https://example.com" }) },
      },
    };
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }], reviews: [review(bob), review(carol)] };
    const members: Membership[] = [{ person: author, orgRole: null, teams: {} }, ...defaultMembers.slice(1)];
    const { run, gateway } = setup({ pr: value, files, members });
    expect((await run()).status).toBe("allowed");
    expect(gateway.orgMembership).toHaveBeenCalledTimes(2);
    expect(gateway.orgMembership).toHaveBeenCalledWith(author);
    expect(gateway.orgMembership).toHaveBeenCalledWith(bob);
  });

  it("website の同意が揃ったら残りの候補の Org 所属を照会しない", async () => {
    const files = {
      alice: {
        before: { ...meta(["bob", "carol"]), profileYaml: null },
        after: { ...meta(["bob", "carol"]), profileYaml: JSON.stringify({ website: "https://example.com" }) },
      },
    };
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }], reviews: [review(bob), review(carol)] };
    const { run, gateway } = setup({ pr: value, files });

    expect((await run()).status).toBe("allowed");
    expect(gateway.orgMembership).toHaveBeenCalledOnce();
    expect(gateway.orgMembership).toHaveBeenCalledWith(bob);
    expect(gateway.orgMembership).not.toHaveBeenCalledWith(carol);
  });

  it("複数ルートの website の同意が揃うまで照会し揃った後は省略する", async () => {
    const dave = { id: 4, login: "dave" };
    const files = {
      alice: {
        before: { ...meta(["bob"]), profileYaml: null },
        after: { ...meta(["bob"]), profileYaml: JSON.stringify({ website: "https://alice.example" }) },
      },
      bob: {
        before: { ...meta(["carol", "dave"]), profileYaml: null },
        after: { ...meta(["carol", "dave"]), profileYaml: JSON.stringify({ website: "https://bob.example" }) },
      },
    };
    const value = {
      ...pr,
      files: [{ path: "authors/alice/profile.yaml" }, { path: "authors/bob/profile.yaml" }],
      baseRoots: ["alice", "bob"],
      reviews: [review(bob), review(carol), review(dave)],
    };
    const members: Membership[] = [...defaultMembers, { person: dave, orgRole: "member", teams: {} }];
    const { run, gateway } = setup({ pr: value, files, members });

    expect((await run()).status).toBe("allowed");
    expect(gateway.orgMembership).toHaveBeenCalledTimes(2);
    expect(gateway.orgMembership).toHaveBeenNthCalledWith(1, bob);
    expect(gateway.orgMembership).toHaveBeenNthCalledWith(2, carol);
    expect(gateway.orgMembership).not.toHaveBeenCalledWith(dave);
  });

  it("取得済みの Team Member の同意で足りれば他の候補の Org を照会しない", async () => {
    const files = {
      alice: {
        before: { ...meta(["bob", "team:blog"]), profileYaml: null },
        after: { ...meta(["bob", "team:blog"]), profileYaml: JSON.stringify({ website: "https://example.com" }) },
      },
    };
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }], reviews: [review(bob), review(carol)] };
    const members: Membership[] = [
      { person: author, orgRole: null, teams: { blog: null } },
      { person: bob, orgRole: "member", teams: { blog: null } },
      { person: carol, orgRole: "member", teams: { blog: "member" } },
    ];
    const { run, gateway } = setup({ pr: value, files, members });

    expect((await run()).status).toBe("allowed");
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("website の同意候補の Org 所属を取得できなければ失敗する", async () => {
    const files = {
      alice: {
        before: { ...meta(["bob", "carol"]), profileYaml: null },
        after: { ...meta(["bob", "carol"]), profileYaml: JSON.stringify({ website: "https://example.com" }) },
      },
    };
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }], reviews: [review(bob), review(carol)] };
    const { run, gateway } = setup({ pr: value, files });
    vi.mocked(gateway.orgMembership).mockImplementation((person) =>
      person.id === carol.id ? Promise.reject(new Error("failed")) : Promise.resolve(null)
    );

    expect(await run()).toMatchObject({ status: "error", reason: "API_ERROR" });
  });

  it.each(["Author", "Reviewer"])("website の同意者が Team Member なら %s の Org 照会を省く", async (actor) => {
    const files = {
      alice: {
        before: { ...meta(["team:blog"]), profileYaml: null },
        after: { ...meta(["team:blog"]), profileYaml: JSON.stringify({ website: "https://example.com" }) },
      },
    };
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }], reviews: [review(bob)] };
    const members: Membership[] = [
      { person: author, orgRole: null, teams: { blog: actor === "Author" ? "member" : null } },
      { person: bob, orgRole: null, teams: { blog: "member" } },
    ];
    const { run, gateway } = setup({ pr: value, files, members });
    expect((await run()).status).toBe("allowed");
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("Author が website の Org 条件を満たしていれば追加 Editor の Org を照会しない", async () => {
    const files = {
      alice: {
        before: { ...meta(["alice"]), profileYaml: null },
        after: { ...meta(["alice", "bob"]), profileYaml: JSON.stringify({ website: "https://example.com" }) },
      },
    };
    const value = {
      ...pr,
      files: [{ path: "authors/alice/profile.yaml" }, { path: "authors/alice/meta.yaml" }],
      reviews: [review(bob)],
    };
    const { run, gateway } = setup({ pr: value, files });
    expect((await run()).status).toBe("allowed");
    expect(gateway.orgMembership).toHaveBeenCalledOnce();
    expect(gateway.orgMembership).toHaveBeenCalledWith(author);
  });

  it("Bot 作成者による authors 以外の変更を Org 非所属として拒否する", async () => {
    const bot = { id: 55, login: "renovate[bot]", isBot: true };
    const value = {
      ...pr,
      author: bot,
      files: [{ path: "scripts/run.js" }],
      commits: [{ sha: "head", authorId: 55, committerId: 55, committerLogin: "renovate[bot]", signature: null }],
    };
    const { run, gateway } = setup({ pr: value });
    expect(await run()).toMatchObject({ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" });
    expect(gateway.orgMembership).not.toHaveBeenCalled();
    expect(gateway.teamMemberships).not.toHaveBeenCalled();
  });

  it("Team 所属が確認できた作成者の混合 PR では Org を照会しない", async () => {
    const value = { ...pr, files: [{ path: "authors/alice/post.md" }, { path: "scripts/run.js" }] };
    const members: Membership[] = [{ person: author, orgRole: null, teams: { blog: "member" } }];
    const { run, gateway } = setup({ pr: value, files: { alice: pair(["team:blog"], ["team:blog"]) }, members });

    expect(await run()).toMatchObject({ status: "allowed" });
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("本人が Editor である通常編集を認可する", async () => {
    const { gateway, run } = setup();
    await expect(run()).resolves.toMatchObject({ status: "allowed" });
    expect(gateway.validateEditors).toHaveBeenCalledOnce();
  });

  it("base に小文字の著者が追加された後の大文字の新規登録を拒否する", async () => {
    const value = { ...pr, files: [{ path: "authors/Foo/post.md" }, { path: "authors/Foo/meta.yaml" }], baseRoots: [] };
    const { run, gateway } = setup({ pr: value, files: { Foo: pair(null, ["alice"]) } });
    expect((await run()).status).toBe("allowed");
    await expect(run({ ...value, baseSha: "new-base", baseRoots: ["foo"] })).resolves.toMatchObject({
      status: "rejected",
      reason: "AUTHOR_ROOT_CASE_CONFLICT",
    });
    expect(gateway.teamMemberships).toHaveBeenCalledTimes(1);
  });

  it("変更していない profile は解析せず上限に算入しない", async () => {
    const files = {
      alice: {
        before: { ...meta(["alice"]), profileYaml: "x".repeat(20000) },
        after: { ...meta(["alice"]), profileYaml: "x".repeat(20000) },
      },
    };
    await expect(setup({ files }).run()).resolves.toMatchObject({ status: "allowed" });
  });

  it("既存ディレクトリに metadata がなければ新規登録として許可しない", async () => {
    const { run } = setup({ files: { alice: pair(null, ["alice"]) } });
    await expect(run()).resolves.toMatchObject({
      status: "rejected",
      reason: "INVALID_EDITORS",
    });
  });

  it("複数ルートで各段階の同意一覧を共有し重複した Editor を除く", async () => {
    const value = {
      ...pr,
      files: [{ path: "authors/alice/post.md" }, { path: "authors/bob/meta.yaml" }],
      baseRoots: ["alice", "bob"],
      reviews: [review(bob)],
    };
    const files = { alice: pair(["alice"], ["alice"]), bob: pair(["alice"], ["alice", "bob"]) };
    const authorize = vi.spyOn(authorization, "authorizeRoot");

    try {
      expect((await setup({ pr: value, files }).run()).status).toBe("allowed");
      expect(authorize).toHaveBeenCalledTimes(4);
      const inputs = authorize.mock.calls.map(([input]) => input.consents);
      expect(inputs[0]).toBe(inputs[1]);
      expect(inputs[2]).toBe(inputs[3]);
      expect(inputs[0]).toHaveLength(1);
      expect(inputs[2]).toHaveLength(2);
    } finally {
      authorize.mockRestore();
    }
  });

  it("複数の著者は全員の認可が必要", async () => {
    const value = { ...pr, files: [...pr.files, { path: "authors/bob/post.md" }], baseRoots: ["alice", "bob"] };
    const files = { alice: pair(["alice"], ["alice"]), bob: pair(["bob"], ["bob"]) };
    expect((await setup({ pr: value, files }).run()).status).toBe("waiting");
    expect((await setup({ pr: { ...value, reviews: [review(bob)] }, files }).run()).status).toBe("allowed");
  });

  it.each([false, true])("Team Member は通常編集と初回登録を認可できる: 初回=%s", async (initial) => {
    const value = {
      ...pr,
      files: initial ? [{ path: "authors/alice/meta.yaml" }] : pr.files,
      baseRoots: initial ? [] : ["alice"],
    };
    const members = [{ person: author, orgRole: "member" as const, teams: { blog: "member" as const } }];
    const files = { alice: pair(initial ? null : ["team:blog"], ["team:blog"]) };
    expect((await setup({ pr: value, files, members }).run()).status).toBe("allowed");
  });

  it("複数 Editor の追加と削除には対象全員の同意が必要", async () => {
    const files = { alice: pair(["alice", "bob"], ["carol"]) };
    const changedPr = { ...pr, files: [{ path: "authors/alice/meta.yaml" }] };
    expect((await setup({ files, pr: { ...changedPr, reviews: [review(carol)] } }).run()).status).toBe("waiting");
    expect((await setup({ files, pr: { ...changedPr, reviews: [review(bob), review(carol)] } }).run()).status).toBe(
      "allowed"
    );
  });

  it("複数の追加先と削除先それぞれの同意を要求する", async () => {
    const dave = { id: 4, login: "dave" };
    const erin = { id: 5, login: "erin" };
    const files = { alice: pair(["alice", "bob", "carol"], ["alice", "dave", "erin"]) };
    const members: Membership[] = [
      ...defaultMembers,
      { person: dave, orgRole: "member", teams: {} },
      { person: erin, orgRole: "member", teams: {} },
    ];
    const value = {
      ...pr,
      files: [{ path: "authors/alice/meta.yaml" }],
      reviews: [review(bob), review(carol), review(dave)],
    };
    expect((await setup({ files, pr: value, members }).run()).status).toBe("waiting");
    expect(
      (await setup({ files, pr: { ...value, reviews: [...value.reviews, review(erin)] }, members }).run()).status
    ).toBe("allowed");
  });

  it.each(["追加", "削除"])("Team の%sには Maintainer が必要", async (change) => {
    const files = {
      alice: change === "追加" ? pair(["alice"], ["alice", "team:blog"]) : pair(["alice", "team:blog"], ["alice"]),
    };
    const value = { ...pr, files: [{ path: "authors/alice/meta.yaml" }], reviews: [review(bob)] };
    const members = [authorMembership, { person: bob, orgRole: "member" as const, teams: { blog: "member" as const } }];
    expect((await setup({ files, pr: value, members }).run()).reason).toBe("TEAM_MAINTAINER_REQUIRED");
    expect(
      (
        await setup({
          files,
          pr: value,
          members: [authorMembership, { person: bob, orgRole: "member", teams: { blog: "maintainer" } }],
        }).run()
      ).status
    ).toBe("allowed");
  });

  it("meta.yaml を meta.yml に改名し Editor が不変なら追加同意を要求しない", async () => {
    const before = meta(["alice", "bob"]);
    const after = { ...blank, metaYml: JSON.stringify(["alice", "bob"]) };
    const value = { ...pr, files: [{ path: "authors/alice/meta.yml", previousPath: "authors/alice/meta.yaml" }] };
    expect((await setup({ pr: value, files: { alice: { before, after } } }).run()).status).toBe("allowed");
  });

  it.each([
    ["追加", null, "https://new", "waiting"],
    ["変更", "https://old", "https://new", "waiting"],
    ["削除", "https://old", null, "allowed"],
    ["不変", "https://same", "https://same", "allowed"],
  ])("website の%sを判定する", async (_name, before, after, status) => {
    const files = {
      alice: {
        before: { ...meta(["alice"]), profileYaml: before === null ? null : JSON.stringify({ website: before }) },
        after: { ...meta(["alice"]), profileYaml: after === null ? null : JSON.stringify({ website: after }) },
      },
    };
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }] };
    const members = [{ person: author, orgRole: null, teams: {} }];
    expect((await setup({ pr: value, files, members }).run()).status).toBe(status);
  });

  it("website 変更は対象 Org Member Editor の有効な Review で認可する", async () => {
    const files = {
      alice: {
        before: { ...meta(["alice", "bob"]), profileYaml: null },
        after: { ...meta(["alice", "bob"]), profileYaml: JSON.stringify({ website: "https://example.com" }) },
      },
    };
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }], reviews: [review(bob)] };
    const members: Membership[] = [
      { person: author, orgRole: null, teams: {} },
      { person: bob, orgRole: "member", teams: {} },
    ];
    expect((await setup({ pr: value, files, members }).run()).status).toBe("allowed");
  });

  it("icon の変更は website の特別な同意を要求しない", async () => {
    const value = { ...pr, files: [{ path: "authors/alice/profile.yaml" }] };
    const files = {
      alice: {
        before: { ...meta(["alice"]), profileYaml: JSON.stringify({ icon: "old.png" }) },
        after: { ...meta(["alice"]), profileYaml: JSON.stringify({ icon: "new.png" }) },
      },
    };
    expect(
      (await setup({ pr: value, files, members: [{ person: author, orgRole: null, teams: {} }] }).run()).status
    ).toBe("allowed");
  });

  it("Org Member の混合 PR でも著者の認可を要求する", async () => {
    const value = { ...pr, files: [...pr.files, { path: "scripts/run.js" }] };
    expect((await setup({ pr: value, files: { alice: pair(["bob"], ["bob"]) } }).run()).status).toBe("waiting");
    expect(
      (
        await setup({
          pr: { ...value, reviews: [review(bob)] },
          files: { alice: pair(["bob"], ["bob"]) },
        }).run()
      ).status
    ).toBe("allowed");
  });

  it("Org Member の著者以外のみの PR は対象外", async () => {
    const value = { ...pr, files: [{ path: "scripts/run.js" }], baseRoots: [] };
    expect((await setup({ pr: value }).run()).status).toBe("not_applicable");
  });

  it("古い Review と COMMENTED の投稿者の所属は照会しない", async () => {
    const value = {
      ...pr,
      reviews: [
        { ...review(bob), commitSha: "old" },
        { ...review(carol), state: "COMMENTED" as const },
      ],
    };
    const { gateway, run } = setup({ pr: value });
    await run();
    expect(gateway.teamMemberships).toHaveBeenCalledWith([author], []);
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("多数の個人 Editor を持つ通常編集では Author だけの所属を確認する", async () => {
    const editors = ["alice", ...Array.from({ length: 50 }, (_, index) => `editor${String(index)}`)];
    const { gateway, run } = setup({ files: { alice: pair(editors, editors) } });
    expect((await run()).status).toBe("allowed");
    expect(gateway.validateEditors).toHaveBeenCalledOnce();
    expect(gateway.teamMemberships).toHaveBeenCalledOnce();
    expect(gateway.teamMemberships).toHaveBeenCalledWith([author], []);
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("個人 Editor と無関係な有効 Review の投稿者は所属を照会しない", async () => {
    const { gateway, run } = setup({ pr: { ...pr, reviews: [review(bob)] } });
    expect((await run()).status).toBe("allowed");
    expect(gateway.teamMemberships).toHaveBeenCalledWith([author], []);
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("Author の同意が不足すると 2 人の有効な Reviewer の Team 所属をまとめて確認する", async () => {
    const value = { ...pr, reviews: [review(bob), review(carol)] };
    const members: Membership[] = [
      { person: author, orgRole: null, teams: { blog: null } },
      { person: bob, orgRole: "member", teams: { blog: "member" } },
      { person: carol, orgRole: "member", teams: { blog: "member" } },
    ];
    const { gateway, run } = setup({ pr: value, files: { alice: pair(["team:blog"], ["team:blog"]) }, members });
    expect((await run()).status).toBe("allowed");
    expect(gateway.teamMemberships).toHaveBeenCalledTimes(2);
    expect(gateway.teamMemberships).toHaveBeenNthCalledWith(1, [author], ["blog"]);
    expect(gateway.teamMemberships).toHaveBeenNthCalledWith(2, [bob, carol], ["blog"]);
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("Team Editor があれば有効 Review の投稿者の所属を照会する", async () => {
    const value = { ...pr, reviews: [review(bob)] };
    const members: Membership[] = [
      { person: author, orgRole: null, teams: { blog: null } },
      { person: bob, orgRole: "member", teams: { blog: "member" } },
    ];
    const { gateway, run } = setup({ pr: value, files: { alice: pair(["team:blog"], ["team:blog"]) }, members });
    expect((await run()).status).toBe("allowed");
    expect(gateway.teamMemberships).toHaveBeenNthCalledWith(1, [author], ["blog"]);
    expect(gateway.teamMemberships).toHaveBeenNthCalledWith(2, [bob], ["blog"]);
    expect(gateway.orgMembership).not.toHaveBeenCalled();
  });

  it("外部 Author の authors 以外の変更を拒否する", async () => {
    const value = { ...pr, files: [{ path: "scripts/run.js" }], baseRoots: [] };
    expect((await setup({ pr: value, members: [{ person: author, orgRole: null, teams: {} }] }).run()).reason).toBe(
      "NON_CONTENT_CHANGE_FORBIDDEN"
    );
  });
});

describe("管理モードの評価", () => {
  const offboarding = { mode: "offboarding", reason: undefined } as const;
  const intervention = { mode: "intervention", reason: undefined } as const;
  const owner = { person: carol, orgRole: "admin", teams: {} } as Membership;
  const external = { person: bob, orgRole: null, teams: {} } as Membership;
  const base = { ...pr, files: [{ path: "authors/alice/meta.yaml" }], reviews: [review(carol)] };

  it("外部 Editor を Owner の承認で削除し、所属照会を再利用する", async () => {
    const { run, gateway } = setup({
      pr: base,
      members: [authorMembership, external, owner],
      files: { alice: pair(["alice", "bob"], ["alice"]) },
    });
    const result = await run(base, offboarding);
    expect(result).toMatchObject({
      status: "allowed",
      management: {
        mode: "offboarding",
        targets: [{ type: "user", login: "bob" }],
        approvers: [{ person: carol, orgRole: "admin" }],
      },
    });
    expect(gateway.orgMembership).toHaveBeenCalledTimes(3);
  });

  it("削除対象が Reviewer でも所属確認を重複しない", async () => {
    const snapshot = { ...base, reviews: [review(bob), review(carol)] };
    const { run, gateway } = setup({
      pr: snapshot,
      members: [authorMembership, external, owner],
      files: { alice: pair(["alice", "bob"], ["alice"]) },
    });
    expect(await run(snapshot, offboarding)).toMatchObject({ status: "allowed" });
    expect(gateway.orgMembership).toHaveBeenCalledTimes(3);
  });

  it.each([null, ["editors", "extra"]])("meta のキーが不正なら Offboarding を拒否する", async (keys) => {
    const { run } = setup({
      pr: base,
      members: [authorMembership, external, owner],
      files: { alice: pair(["alice", "bob"], ["alice"]) },
      readMetaKeys: () => keys,
    });
    expect(await run(base, offboarding)).toMatchObject({ status: "rejected", reason: "OFFBOARDING_INVALID_CHANGES" });
  });

  it("キーが不正でも作成者が非 Member なら通常の認可で評価する", async () => {
    const { run, gateway } = setup({
      pr: base,
      members: [{ ...authorMembership, orgRole: null }, external, owner],
      files: { alice: pair(["bob"], ["alice"]) },
      readMetaKeys: () => ["editors", "extra"],
    });
    expect(await run(base, offboarding)).toMatchObject({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      management: { mode: "none", reason: "NOT_MEMBER" },
    });
    expect(gateway.orgMembership).toHaveBeenCalledTimes(1);
  });

  it("削除対象の Org 所属を取得できなければエラーにする", async () => {
    const { run, gateway } = setup({
      pr: base,
      members: [authorMembership, external, owner],
      files: { alice: pair(["alice", "bob"], ["alice"]) },
    });
    vi.mocked(gateway.orgMembership).mockImplementation((person) =>
      person.id === bob.id ? Promise.reject(new Error("unavailable")) : Promise.resolve("member")
    );
    const result = await run(base, offboarding);
    expect(result).toMatchObject({ status: "error", reason: "API_ERROR" });
    expect(result.reason).not.toBe("OFFBOARDING_INVALID_TARGET");
  });

  it("対象が Org Member の場合は拒否する", async () => {
    const { run } = setup({
      pr: base,
      members: [authorMembership, { ...external, orgRole: "member" }, owner],
      files: { alice: pair(["alice", "bob"], ["alice"]) },
    });
    expect(await run(base, offboarding)).toMatchObject({ status: "rejected", reason: "OFFBOARDING_INVALID_TARGET" });
  });

  it("Owner の有効な承認がなければ待機する", async () => {
    const snapshot = { ...base, reviews: [{ ...review(carol), commitSha: "old" }] };
    const { run } = setup({
      pr: snapshot,
      members: [authorMembership, external, owner],
      files: { alice: pair(["alice", "bob"], ["alice"]) },
    });
    expect(await run(snapshot, offboarding)).toMatchObject({
      status: "waiting",
      reason: "OFFBOARDING_APPROVAL_MISSING",
    });
  });

  it("最後の Editor の削除を拒否する", async () => {
    const { run } = setup({
      pr: base,
      members: [authorMembership, external, owner],
      files: { alice: pair(["bob"], []) },
    });
    expect(await run(base, offboarding)).toMatchObject({ status: "rejected", reason: "INVALID_EDITORS" });
  });

  it("ファイルの混在を拒否する", async () => {
    const snapshot = { ...base, files: [...base.files, { path: "authors/alice/post.md" }] };
    const { run } = setup({
      pr: snapshot,
      members: [authorMembership, external, owner],
      files: { alice: pair(["alice", "bob"], ["alice"]) },
    });
    expect(await run(snapshot, offboarding)).toMatchObject({
      status: "rejected",
      reason: "OFFBOARDING_INVALID_CHANGES",
    });
  });

  it("所属未確認の管理申請は早期エラーに有効なモードを付けない", async () => {
    const { run, gateway } = setup({ pr: base });
    const mismatch = { ...base, commits: [] };
    const collision = { ...base, files: [{ path: "authors/Alice/meta.yaml" }] };
    expect(await run(mismatch, intervention)).toMatchObject({
      reason: "COMMIT_IDENTITY_MISMATCH",
      management: undefined,
    });
    expect(await run(collision, intervention)).toMatchObject({
      reason: "AUTHOR_ROOT_CASE_CONFLICT",
      management: undefined,
    });
    vi.mocked(gateway.orgMembership).mockRejectedValue(new Error("unavailable"));
    expect(await run(base, intervention)).toMatchObject({ status: "error", management: undefined });
  });

  it("早期エラーでも無効な申請の理由を残す", async () => {
    const { run } = setup({ pr: base });
    expect(await run({ ...base, commits: [] }, { mode: "none", reason: "HISTORY_UNAVAILABLE" })).toMatchObject({
      reason: "COMMIT_IDENTITY_MISMATCH",
      management: { mode: "none", reason: "HISTORY_UNAVAILABLE" },
    });
  });

  it("作成者の所属を判定できなければエラーにする", async () => {
    const { run, gateway } = setup({ pr: base });
    vi.mocked(gateway.orgMembership).mockRejectedValue(new Error("unavailable"));
    expect(await run(base, intervention)).toMatchObject({ status: "error", reason: "API_ERROR" });
  });

  it("作成者が非 Member の場合は通常の認可で評価する", async () => {
    const { run } = setup({
      pr: base,
      members: [{ ...authorMembership, orgRole: null }, external, owner],
      files: { alice: pair(["bob"], ["alice"]) },
    });
    expect(await run(base, offboarding)).toMatchObject({
      status: "waiting",
      reason: "EDITOR_APPROVAL_MISSING",
      management: { reason: "NOT_MEMBER", mode: "none" },
    });
  });

  it("Intervention は重複を除く Owner と Member 3 人で成立する", async () => {
    const reviewers: Membership[] = [
      owner,
      { person: { id: 4, login: "dave" }, orgRole: "member", teams: {} },
      { person: { id: 5, login: "erin" }, orgRole: "member", teams: {} },
      { person: { id: 6, login: "frank" }, orgRole: "member", teams: {} },
    ];
    const snapshot = { ...pr, reviews: reviewers.map((member) => review(member.person)) };
    const { run } = setup({
      pr: snapshot,
      members: [authorMembership, ...reviewers],
      files: { alice: pair(["bob"], ["bob"]) },
    });
    expect(await run(snapshot, intervention)).toMatchObject({
      status: "allowed",
      management: { mode: "intervention" },
    });
    const insufficient = { ...snapshot, reviews: [...snapshot.reviews.slice(0, 3), ...snapshot.reviews.slice(0, 1)] };
    expect(await run(insufficient, intervention)).toMatchObject({
      status: "waiting",
      reason: "INTERVENTION_QUORUM_MISSING",
    });
  });
});
