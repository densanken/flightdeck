import { describe, expect, it } from "vitest";

import { GitHubGatewayImpl } from "./client.js";
import { REPOSITORY_QUERY } from "./state.js";

import type { Fetcher } from "./request.js";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  accept: string | null;
}

// "METHOD /path?query" をキーに応答を返す
// 未登録の request は 500 にして、想定外の呼び出しを検出する
const createFetcher = (routes: Record<string, (init: RequestInit) => Response>) => {
  const requests: RecordedRequest[] = [];
  const fetcher: Fetcher = (url, init) => {
    const parsed = new URL(url);
    const key = `${init.method ?? "GET"} ${parsed.pathname}${parsed.search}`;
    requests.push({
      method: init.method ?? "GET",
      url: key,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      accept: new Headers(init.headers).get("accept"),
    });
    return Promise.resolve(routes[key]?.(init) ?? new Response("unexpected request", { status: 500 }));
  };
  return { requests, gateway: new GitHubGatewayImpl({ fetcher, getToken: () => Promise.resolve("token") }) };
};

const json = (body: unknown, init?: ResponseInit) => () => Response.json(body, init);

describe("tree と commit の作成", () => {
  it("base_tree を指定し、対象の gitlink だけを 160000 の commit として差し替える", async () => {
    const { gateway, requests } = createFetcher({ "POST /repos/o/p/git/trees": json({ sha: "new-tree" }) });

    const sha = await gateway.createGitlinkTree("o/p", { baseTreeSha: "T", path: "content/blog", gitlinkSha: "S" });

    expect(sha).toBe("new-tree");
    expect(requests[0]?.body).toEqual({
      base_tree: "T",
      tree: [{ path: "content/blog", mode: "160000", type: "commit", sha: "S" }],
    });
  });

  it("親を base 1 つだけにした commit を作る", async () => {
    const { gateway, requests } = createFetcher({ "POST /repos/o/p/git/commits": json({ sha: "N" }) });

    await expect(gateway.createCommit("o/p", { treeSha: "T2", parentSha: "B", message: "m" })).resolves.toBe("N");
    expect(requests[0]?.body).toEqual({ message: "m", tree: "T2", parents: ["B"] });
  });
});

// ref の更新の前に読む repository の node ID の問い合わせには、ID を返す
const isRepositoryIdQuery = (init: RequestInit) =>
  typeof init.body === "string" && init.body.includes("ReadRepositoryId");
const repositoryId = () => Response.json({ data: { repository: { id: "R_node" } } });

describe("updateRef", () => {
  const route = (body: unknown) => ({
    "POST /graphql": (init: RequestInit) => (isRepositoryIdQuery(init) ? repositoryId() : Response.json(body)),
  });

  it("新規 branch にはゼロ OID を before に使い、force 付きの CAS として送る", async () => {
    const { gateway, requests } = createFetcher(route({ data: { updateRefs: { clientMutationId: null } } }));

    await expect(
      gateway.updateRef("o/p", "flightdeck-dispatch/a-b-submodule", {
        before: undefined,
        after: "N",
      })
    ).resolves.toBe("updated");

    const graphql = requests.at(-1)?.body as {
      query: string;
      variables: unknown;
    };
    expect(graphql.query).toContain("force: true");
    expect(graphql.variables).toEqual({
      repositoryId: "R_node",
      ref: "refs/heads/flightdeck-dispatch/a-b-submodule",
      before: "0".repeat(40),
      after: "N",
    });
  });

  it("既存 branch には現在の HEAD を before に使う", async () => {
    const { gateway, requests } = createFetcher(route({ data: {} }));

    await gateway.updateRef("o/p", "b", { before: "H", after: "N" });

    const graphql = requests.at(-1)?.body as {
      variables: { before: string };
    };
    expect(graphql.variables.before).toBe("H");
  });

  const withHead = (head: string, body: unknown) => ({
    ...route(body),
    "GET /repos/o/p/git/ref/heads/b": json({ object: { sha: head } }),
  });

  it("エラー時に branch の HEAD が before から動いていれば conflict として返し、REST の force update へ fallback しない", async () => {
    const { gateway, requests } = createFetcher(withHead("other", { errors: [{ message: "anything" }] }));

    await expect(gateway.updateRef("o/p", "b", { before: "H", after: "N" })).resolves.toBe("conflict");
    expect(requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("HEAD が動いていなければ、分類済みのエラーをそのまま返す（FORBIDDEN は permission、type のない失敗は retryable）", async () => {
    const call = { before: "H", after: "N" };
    const forbidden = createFetcher(withHead("H", { errors: [{ type: "FORBIDDEN", message: "x" }] }));
    await expect(forbidden.gateway.updateRef("o/p", "b", call)).rejects.toMatchObject({ kind: "permission" });

    const untyped = createFetcher(withHead("H", { errors: [{ message: "timeout" }] }));
    await expect(untyped.gateway.updateRef("o/p", "b", call)).rejects.toMatchObject({ kind: "retryable" });
  });

  it("GraphQL の rate limit は、応答の header の待ち時間で retryable にする（なければ既定値）", async () => {
    const limited = (headers: Record<string, string>) =>
      new GitHubGatewayImpl({
        fetcher: (url, init) =>
          Promise.resolve(
            new URL(url).pathname.includes("/git/ref/")
              ? Response.json({ object: { sha: "H" } })
              : isRepositoryIdQuery(init)
                ? repositoryId()
                : Response.json({ errors: [{ type: "RATE_LIMITED", message: "limit" }] }, { headers })
          ),
        getToken: () => Promise.resolve("token"),
      });
    const call = { before: "H", after: "N" };

    await expect(limited({ "retry-after": "17" }).updateRef("o/p", "b", call)).rejects.toMatchObject({
      kind: "retryable",
      retryAfterSeconds: 17,
    });
    await expect(limited({}).updateRef("o/p", "b", call)).rejects.toMatchObject({
      kind: "retryable",
      retryAfterSeconds: 60,
    });
  });
});

describe("読み取り", () => {
  it("branch の HEAD を返し、存在しなければ undefined を返す", async () => {
    const { gateway } = createFetcher({
      "GET /repos/o/p/git/ref/heads/feature/x": json({ object: { sha: "abc" } }),
      "GET /repos/o/p/git/ref/heads/missing": json({ message: "Not Found" }, { status: 404 }),
    });

    await expect(gateway.getBranchHead("o/p", "feature/x")).resolves.toBe("abc");
    await expect(gateway.getBranchHead("o/p", "missing")).resolves.toBeUndefined();
  });

  it("契約と異なる応答は undeterminable として扱う", async () => {
    const { gateway } = createFetcher({ "POST /graphql": json({ data: { unexpected: true } }) });

    await expect(gateway.readRepositoryState("o/p")).rejects.toMatchObject({ kind: "undeterminable" });
  });
});

describe("PR の更新", () => {
  it("Close とタイトル変更を 1 回の PATCH で送り、指定のない項目は送らない", async () => {
    const { gateway, requests } = createFetcher({ "PATCH /repos/o/p/pulls/3": json({}) });

    await gateway.updatePullRequest("o/p", 3, { title: "t - autoclosed", closed: true });
    await gateway.updatePullRequest("o/p", 3, { baseBranch: "dev" });
    await gateway.updatePullRequest("o/p", 3, { body: "b" });

    expect(requests[0]?.body).toEqual({ title: "t - autoclosed", state: "closed" });
    expect(requests[1]?.body).toEqual({ base: "dev" });
    expect(requests[2]?.body).toEqual({ body: "b" });
  });

  it("PR を Open に戻して title を書き換え、GitHub が 422 で拒否したら false を返す", async () => {
    const reopened = createFetcher({ "PATCH /repos/o/p/pulls/3": json({}) });
    await expect(reopened.gateway.reopenPullRequest("o/p", 3, "t")).resolves.toBe(true);
    expect(reopened.requests[0]?.body).toEqual({ state: "open", title: "t" });

    const rejected = createFetcher({ "PATCH /repos/o/p/pulls/3": json({}, { status: 422 }) });
    await expect(rejected.gateway.reopenPullRequest("o/p", 3, "t")).resolves.toBe(false);
  });

  it("Draft ではない PR を作成する", async () => {
    const { gateway, requests } = createFetcher({ "POST /repos/o/p/pulls": json({}, { status: 201 }) });

    await gateway.createPullRequest("o/p", { head: "h", base: "main", title: "t", body: "b" });

    expect(requests[0]?.body).toEqual({ head: "h", base: "main", title: "t", body: "b", draft: false });
  });
});

describe("compareCommits", () => {
  it("応答が 1 MiB を超えたら、解釈せずに undefined を返す", async () => {
    const commits = [{ sha: "A", commit: { message: "x".repeat(1024 * 1024) } }];
    const { gateway } = createFetcher({
      "GET /repos/o/src/compare/P...S": json({ total_commits: 1, commits }),
    });

    await expect(gateway.compareCommits("o/src", "P", "S")).resolves.toBeUndefined();
  });

  it("compare の commit を古い順のまま、件名（message の 1 行目）だけで返す", async () => {
    const { gateway } = createFetcher({
      "GET /repos/o/src/compare/P...S": json({
        total_commits: 300,
        commits: [
          { sha: "A", commit: { message: "first\r\n\r\nbody" } },
          { sha: "B", commit: { message: "second" } },
        ],
      }),
    });

    await expect(gateway.compareCommits("o/src", "P", "S")).resolves.toEqual({
      commits: [
        { sha: "A", subject: "first" },
        { sha: "B", subject: "second" },
      ],
      total: 300,
    });
  });

  it("比べられない（404）なら undefined を返す", async () => {
    const { gateway } = createFetcher({
      "GET /repos/o/src/compare/P...S": json({ message: "Not Found" }, { status: 404 }),
    });

    await expect(gateway.compareCommits("o/src", "P", "S")).resolves.toBeUndefined();
  });
});

const graphql = (data: unknown, errors?: unknown) => json(errors ? { data, errors } : { data });
const blob = (text: string | null, extra: Record<string, unknown> = {}) => ({
  text,
  isTruncated: false,
  ...extra,
});
// readRepositoryState が返す設定ファイル
const yml = (text: string | null) => ({ path: ".github/flightdeck.yml", text });
const yaml = (text: string | null) => ({ path: ".github/flightdeck.yaml", text });
const repositoryFields = { id: "R_node", nameWithOwner: "o/p" };

describe("readRepositoryState", () => {
  const sourceData = (overrides: Record<string, unknown> = {}) => ({
    repository: {
      ...repositoryFields,
      defaultBranchRef: {
        name: "main",
        target: { oid: "S", yml: { object: blob("targets:\n  - repository: o/x\n    path: sub\n") } },
      },
      previous: undefined,
      managed: undefined,
      ...overrides,
    },
  });

  it("repository、default branch の HEAD、設定の本文を読む", async () => {
    const { gateway, requests } = createFetcher({ "POST /graphql": graphql(sourceData()) });

    await expect(gateway.readRepositoryState("o/p")).resolves.toEqual({
      repository: { fullName: "o/p", defaultBranch: "main" },
      sha: "S",
      configs: [yml("targets:\n  - repository: o/x\n    path: sub\n")],
      previous: undefined,
      managed: [],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      variables: { owner: "o", name: "p", hasPrevious: false, withManaged: false },
    });
  });

  it("設定の本文は、不正でも切り詰められていても、そのまま返す（検査は use case が行う）", async () => {
    for (const text of ["targets: [unclosed", "x".repeat(1000)]) {
      const data = sourceData({
        defaultBranchRef: { name: "main", target: { oid: "S", yml: { object: blob(text) } } },
      });
      const { gateway } = createFetcher({ "POST /graphql": graphql(data) });

      expect((await gateway.readRepositoryState("o/p")).configs).toEqual([yml(text)]);
    }
  });

  it("default branch や設定ファイルがなければ undefined にする。本文のない Blob と切り詰められた Blob は null（読めない）にする", async () => {
    const empty = createFetcher({ "POST /graphql": graphql(sourceData({ defaultBranchRef: null })) });
    await expect(empty.gateway.readRepositoryState("o/p")).resolves.toMatchObject({ sha: undefined, configs: [] });

    const noFile = createFetcher({
      "POST /graphql": graphql(
        sourceData({ defaultBranchRef: { name: "main", target: { oid: "S", yml: null, yaml: null } } })
      ),
    });
    await expect(noFile.gateway.readRepositoryState("o/p")).resolves.toMatchObject({ sha: "S", configs: [] });

    const binary = createFetcher({
      "POST /graphql": graphql(
        sourceData({ defaultBranchRef: { name: "main", target: { oid: "S", yml: { object: blob(null) } } } })
      ),
    });
    await expect(binary.gateway.readRepositoryState("o/p")).resolves.toMatchObject({ configs: [yml(null)] });

    // 切り詰められた本文は、一部の target だけの設定として読まないよう null にする
    const truncated = createFetcher({
      "POST /graphql": graphql(
        sourceData({
          defaultBranchRef: {
            name: "main",
            target: { oid: "S", yml: { object: blob("targets:\n  - repository: o/x\n", { isTruncated: true }) } },
          },
        })
      ),
    });
    await expect(truncated.gateway.readRepositoryState("o/p")).resolves.toMatchObject({ configs: [yml(null)] });

    // 旧設定でも同じ
    const previous = createFetcher({
      "POST /graphql": graphql(
        sourceData({
          previous: { oid: "B", yml: { object: blob("x", { isTruncated: true }) }, yaml: { object: blob(null) } },
        })
      ),
    });
    await expect(previous.gateway.readRepositoryState("o/p", { previous: { sha: "b" } })).resolves.toMatchObject({
      previous: { configs: [yml(null), yaml(null)] },
    });
  });

  it("旧設定は、ref がない、ファイルがない、本文あり、の 3 つを区別する", async () => {
    const previous = async (value: unknown) =>
      createFetcher({ "POST /graphql": graphql(sourceData({ previous: value })) }).gateway.readRepositoryState("o/p", {
        previous: { sha: "b" },
      });

    expect((await previous(null)).previous).toBeUndefined();
    expect((await previous({})).previous).toBeUndefined();
    expect((await previous({ oid: "B", yml: null, yaml: null })).previous).toEqual({ configs: [] });
    expect((await previous({ oid: "B", yml: { object: blob("targets: []\n") } })).previous).toEqual({
      configs: [yml("targets: []\n")],
    });
  });

  it("設定ファイルは .yml と .yaml のどちらも読み、あるものだけを返す（現在の設定も旧設定も）", async () => {
    const at = (files: Record<string, unknown>) => ({
      defaultBranchRef: { name: "main", target: { oid: "S", ...files } },
      previous: { oid: "B", ...files },
    });
    const read = async (files: Record<string, unknown>) =>
      createFetcher({ "POST /graphql": graphql(sourceData(at(files))) }).gateway.readRepositoryState("o/p", {
        previous: { sha: "b" },
      });

    const onlyYml = await read({ yml: { object: blob("a") }, yaml: null });
    expect([onlyYml.configs, onlyYml.previous]).toEqual([[yml("a")], { configs: [yml("a")] }]);

    const onlyYaml = await read({ yml: null, yaml: { object: blob("b") } });
    expect([onlyYaml.configs, onlyYaml.previous]).toEqual([[yaml("b")], { configs: [yaml("b")] }]);

    const both = await read({ yml: { object: blob("a") }, yaml: { object: blob("b") } });
    expect([both.configs, both.previous]).toEqual([[yml("a"), yaml("b")], { configs: [yml("a"), yaml("b")] }]);

    expect(REPOSITORY_QUERY).toContain(".github/flightdeck.yml");
    expect(REPOSITORY_QUERY).toContain(".github/flightdeck.yaml");
  });

  it("存在しない旧 ref や設定ファイルが NOT_FOUND（field の下の path）で返っても、data が null のものとして扱う", async () => {
    const notFound = (...path: string[]) => ({ type: "NOT_FOUND", message: "x", path: ["repository", ...path] });
    const read = (data: unknown, errors: unknown[]) =>
      createFetcher({ "POST /graphql": graphql(data, errors) }).gateway.readRepositoryState("o/p", {
        previous: { sha: "b" },
      });

    const previous = { repository: { ...sourceData().repository, previous: null } };
    await expect(read(previous, [notFound("previous")])).resolves.toMatchObject({ previous: undefined });

    const head = (target: unknown) => ({
      repository: { ...sourceData().repository, defaultBranchRef: { name: "main", target } },
    });
    await expect(
      read(head({ oid: "S", yml: { object: blob("a") }, yaml: null }), [notFound("defaultBranchRef", "target", "yaml")])
    ).resolves.toMatchObject({ configs: [yml("a")] });
    await expect(
      read(head({ oid: "S", yml: null, yaml: { object: blob("b") } }), [notFound("defaultBranchRef", "target", "yml")])
    ).resolves.toMatchObject({ configs: [yaml("b")] });

    // top-level の field 自体の NOT_FOUND は、repository が見えない失敗として分類する
    await expect(read(previous, [notFound()])).rejects.toMatchObject({ kind: "permission" });
  });

  it("旧設定を指定したときだけ、変数で問い合わせる", async () => {
    const { gateway, requests } = createFetcher({ "POST /graphql": graphql(sourceData()) });

    await gateway.readRepositoryState("o/p", { previous: { sha: "B" } });
    await gateway.readRepositoryState("o/p", { previous: { branch: "main" } });
    await gateway.readRepositoryState("o/p");

    expect(requests.map((request) => request.body)).toMatchObject([
      { variables: { hasPrevious: true, previous: "B" } },
      { variables: { hasPrevious: true, previous: "refs/heads/main" } },
      { variables: { hasPrevious: false } },
    ]);
  });
});

describe("readRepositoryState の管理 branch", () => {
  const ref = (name: string, bases: string[], hasNextPage = false) => ({
    name,
    associatedPullRequests: {
      pageInfo: { hasNextPage },
      nodes: bases.map((baseRefName) => ({ number: 1, title: "t", baseRefName, repository: { id: "R_node" } })),
    },
  });
  const withManaged = (managed: unknown) => ({
    repository: {
      ...repositoryFields,
      defaultBranchRef: { name: "main", target: { oid: "S", file: null } },
      managed,
    },
  });
  const read = (managed: unknown) =>
    createFetcher({ "POST /graphql": graphql(withManaged(managed)) }).gateway.readRepositoryState("o/p", {
      withManaged: true,
    });

  it("Open PR を持つ管理 branch と、PR の base を返す。PR のない branch と管理 branch でない branch は含めない", async () => {
    const state = await read({
      pageInfo: { hasNextPage: false },
      nodes: [
        ref("flightdeck-dispatch/a/src", ["main", "develop"]),
        ref("flightdeck-dispatch/b/lib", []),
        // query は prefix で始まらない branch も返しうる
        ref("feature/flightdeck-dispatch/c/d", ["main"]),
      ],
    });

    expect(state.managed).toEqual([{ head: "flightdeck-dispatch/a/src", baseBranches: ["main", "develop"] }]);
    // refPrefix に管理 branch の prefix を含めると、GitHub は associatedPullRequests を空で返す
    expect(REPOSITORY_QUERY).toContain('refPrefix: "refs/heads/", query: "flightdeck-dispatch/"');
  });

  it("別の repository の PR（fork の管理 branch から upstream へ出された PR など）は除き、残らない branch は含めない", async () => {
    const foreign = (name: string) => ({
      name,
      associatedPullRequests: {
        pageInfo: { hasNextPage: false },
        nodes: [{ number: 7, title: "t", baseRefName: "main", repository: { id: "R_upstream" } }],
      },
    });
    const state = await read({
      pageInfo: { hasNextPage: false },
      nodes: [foreign("flightdeck-dispatch/a/only-foreign"), ref("flightdeck-dispatch/b/own", ["main"])],
    });

    expect(state.managed).toEqual([{ head: "flightdeck-dispatch/b/own", baseBranches: ["main"] }]);
  });

  it("branch が 1 ページに収まらない、または PR が 1 ページに収まらないなら overflow にする", async () => {
    expect((await read({ pageInfo: { hasNextPage: true }, nodes: [] })).managed).toBe("overflow");
    expect(
      (await read({ pageInfo: { hasNextPage: false }, nodes: [ref("flightdeck-dispatch/a/src", ["main"], true)] }))
        .managed
    ).toBe("overflow");
  });

  it("指定したときだけ問い合わせる。指定しなければ空にする", async () => {
    const { gateway, requests } = createFetcher({ "POST /graphql": graphql(withManaged(undefined)) });

    expect((await gateway.readRepositoryState("o/p")).managed).toEqual([]);
    await gateway.readRepositoryState("o/p", { withManaged: true });

    expect(
      requests.map((request) => (request.body as { variables: { withManaged: boolean } }).variables.withManaged)
    ).toEqual([false, true]);
  });
});

describe("checkUnchanged", () => {
  const source = { repository: "a/src", defaultBranch: "main", sha: "S" };
  const parent = { repository: "b/parent", branch: "main", sha: "B" };
  const create = (sourceData: unknown, parentData: unknown) => {
    const requests: { token: string | null; variables: Record<string, unknown> }[] = [];
    const gateway = new GitHubGatewayImpl({
      fetcher: (_url, init) => {
        const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
        requests.push({ token: new Headers(init.headers).get("authorization"), variables: body.variables });
        return Promise.resolve(Response.json({ data: body.query.includes("CheckSource") ? sourceData : parentData }));
      },
      getToken: (repository) => Promise.resolve(repository === "a/src" ? "t1" : "t2"),
    });
    return { gateway, requests };
  };
  const sourceHead = (name = "main", oid = "S") => ({ repository: { defaultBranchRef: { name, target: { oid } } } });
  const parentHead = (oid: string | null = "B") => ({
    repository: { ref: { target: oid === null ? null : { oid } } },
  });

  it("source と parent を、それぞれの token で別々の問い合わせにして確かめる", async () => {
    const { gateway, requests } = create(sourceHead(), parentHead());

    await expect(gateway.checkUnchanged({ source, parent })).resolves.toBe(true);

    expect(requests.map((request) => request.token).sort()).toEqual(["Bearer t1", "Bearer t2"]);
    expect(requests.find((request) => request.token === "Bearer t2")?.variables).toMatchObject({
      owner: "b",
      name: "parent",
      ref: "refs/heads/main",
    });
  });

  it.each([
    ["source の HEAD が動いた", sourceHead("main", "S2"), parentHead()],
    ["source の default branch の名前が変わった", sourceHead("trunk"), parentHead()],
    ["parent の base が動いた", sourceHead(), parentHead("B2")],
    ["parent の base がなくなった", sourceHead(), parentHead(null)],
  ])("%s なら false にする", async (_name, sourceData, parentData) => {
    const { gateway } = create(sourceData, parentData);

    await expect(gateway.checkUnchanged({ source, parent })).resolves.toBe(false);
  });
});

describe("readParentState", () => {
  const baseCommit = (overrides: Record<string, unknown> = {}) => ({
    oid: "B",
    tree: { oid: "T" },
    link: { type: "commit", oid: "P" },
    submodules: { nodes: [{ path: "sub", gitUrl: "git@github.com:o/a.git" }], pageInfo: { hasNextPage: false } },
    ...overrides,
  });
  const parentData = (overrides: Record<string, unknown> = {}) => ({
    repository: {
      ...repositoryFields,
      defaultBranchRef: { name: "main", target: baseCommit() },
      base: null,
      branch: {
        associatedPullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: [
            { number: 3, title: "t", baseRefName: "main", repository: { id: "R_node" }, body: "b" },
            // 同じ番号でも、別の repository の PR は除く
            { number: 3, title: "upstream", baseRefName: "main", repository: { id: "R_upstream" }, body: "b" },
          ],
        },
        target: {
          oid: "H",
          message: "m",
          changedFilesIfAvailable: 1,
          link: { type: "commit", oid: "S" },
          parents: { nodes: [{ oid: "B" }] },
        },
      },
      latest: { nodes: [] },
      ...overrides,
    },
  });
  const input = { baseBranch: undefined, head: "h", path: "sub" };

  it("base を省略すると default branch を base とし、1 回の問い合わせで必要な状態を返す", async () => {
    const { gateway, requests } = createFetcher({ "POST /graphql": graphql(parentData()) });

    const state = await gateway.readParentState("o/p", input);

    expect(state.repository).toEqual({ fullName: "o/p", defaultBranch: "main" });
    expect(state.base).toEqual({
      branch: "main",
      sha: "B",
      treeSha: "T",
      gitlinkSha: "P",
      submodules: [{ path: "sub", url: "git@github.com:o/a.git" }],
    });
    expect(state.branch).toEqual({
      sha: "H",
      parentShas: ["B"],
      message: "m",
      gitlinkSha: "S",
      changedFiles: 1,
    });
    // head が同じ repository の branch である PR だけが返る（fork の PR は GitHub が含めない）
    expect(state.pullRequests).toEqual([{ number: 3, title: "t", baseBranch: "main", body: "b" }]);
    expect(requests).toHaveLength(1);
    expect(state.lastClosedPullRequest).toBeUndefined();
    expect(requests[0]?.body).toMatchObject({
      variables: { headRef: "refs/heads/h", headName: "h", hasBase: false, path: "sub" },
    });
  });

  describe("最後に Close された PR", () => {
    const pr = (number: number, state: string, closedAt: string | null, headRepository: { id: string } | null) => ({
      number,
      title: `t${String(number)}`,
      state,
      closedAt,
      headRefOid: `H${String(number)}`,
      headRepository,
    });
    const read = async (nodes: unknown[]) =>
      (
        await createFetcher({ "POST /graphql": graphql(parentData({ latest: { nodes } })) }).gateway.readParentState(
          "o/p",
          input
        )
      ).lastClosedPullRequest;

    it("fork から開かれた PR を除き、作成順ではなく Close の日時が最後の PR を返す", async () => {
      await expect(
        read([
          pr(9, "OPEN", null, { id: "R_fork" }),
          pr(8, "CLOSED", "2026-01-03T00:00:00Z", null),
          pr(7, "CLOSED", "2026-01-01T00:00:00Z", { id: "R_node" }),
          pr(6, "MERGED", "2026-01-02T00:00:00Z", { id: "R_node" }),
        ])
      ).resolves.toEqual({ number: 6, title: "t6", merged: true, headSha: "H6" });
    });

    it("Open の PR があれば undefined にする", async () => {
      await expect(
        read([pr(8, "OPEN", null, { id: "R_node" }), pr(7, "CLOSED", "2026-01-01T00:00:00Z", { id: "R_node" })])
      ).resolves.toBeUndefined();
    });
  });

  it("base-branch を明示すると、その branch を base とする", async () => {
    const data = parentData({ base: { target: baseCommit({ oid: "D" }) } });
    const { gateway, requests } = createFetcher({ "POST /graphql": graphql(data) });

    const state = await gateway.readParentState("o/p", { ...input, baseBranch: "dev" });

    expect(state.base).toMatchObject({ branch: "dev", sha: "D" });
    expect(requests[0]?.body).toMatchObject({ variables: { baseRef: "refs/heads/dev", hasBase: true } });
  });

  it("branch や base が存在しなければ undefined にする", async () => {
    const data = parentData({ base: null, branch: null });
    const { gateway } = createFetcher({ "POST /graphql": graphql(data) });

    const explicit = await gateway.readParentState("o/p", { ...input, baseBranch: "missing" });
    expect(explicit.base).toBeUndefined();
    expect(explicit.branch).toBeUndefined();
  });

  it("path が parent にないことを表す NOT_FOUND（link の alias）は、gitlink でないものとして扱う", async () => {
    const data = parentData({ defaultBranchRef: { name: "main", target: baseCommit({ link: null }) } });
    const errors = [
      { type: "NOT_FOUND", message: "x", path: ["repository", "defaultBranchRef", "target", "link"] },
      { type: "NOT_FOUND", message: "x", path: ["repository", "branch", "target", "link"] },
    ];
    const { gateway } = createFetcher({ "POST /graphql": graphql(data, errors) });

    expect((await gateway.readParentState("o/p", input)).base?.gitlinkSha).toBeUndefined();
  });

  it("path が gitlink でなければ gitlinkSha を undefined にする", async () => {
    for (const link of [{ type: "blob", oid: "F" }, { type: "tree", oid: "D" }, null]) {
      const data = parentData({ defaultBranchRef: { name: "main", target: baseCommit({ link }) } });
      const { gateway } = createFetcher({ "POST /graphql": graphql(data) });

      expect((await gateway.readParentState("o/p", input)).base?.gitlinkSha).toBeUndefined();
    }
  });

  it("submodule の一覧が 1 ページに収まらなければ undeterminable にする", async () => {
    const data = parentData({
      defaultBranchRef: {
        name: "main",
        target: baseCommit({ submodules: { nodes: [], pageInfo: { hasNextPage: true } } }),
      },
    });
    const { gateway } = createFetcher({ "POST /graphql": graphql(data) });

    await expect(gateway.readParentState("o/p", input)).rejects.toMatchObject({ kind: "undeterminable" });
  });

  it("base-branch を明示したときは、default branch の base を問い合わせない", async () => {
    const { gateway, requests } = createFetcher({
      "POST /graphql": graphql(parentData({ defaultBranchRef: { name: "main" }, base: { target: baseCommit() } })),
    });

    await expect(gateway.readParentState("o/p", { ...input, baseBranch: "dev" })).resolves.toMatchObject({
      base: { branch: "dev" },
    });
    expect((requests[0]?.body as { query: string }).query).toContain("@skip(if: $hasBase)");
  });

  it("紐づく PR がすべて別の repository のものなら、PR なしとして返す（use case は PR を新規に作る）", async () => {
    const data = parentData({
      branch: {
        associatedPullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: [{ number: 3, title: "upstream", baseRefName: "main", repository: { id: "R_upstream" }, body: "b" }],
        },
        target: null,
      },
    });
    const { gateway } = createFetcher({ "POST /graphql": graphql(data) });

    expect((await gateway.readParentState("o/p", input)).pullRequests).toEqual([]);
  });

  it("branch の Open PR が 1 ページに収まらなければ undeterminable にする", async () => {
    const data = parentData({
      branch: { associatedPullRequests: { pageInfo: { hasNextPage: true }, nodes: [] }, target: null },
    });
    const { gateway } = createFetcher({ "POST /graphql": graphql(data) });

    await expect(gateway.readParentState("o/p", input)).rejects.toMatchObject({ kind: "undeterminable" });
  });
});

describe("readManagedPullRequests", () => {
  const managed = (nodes: unknown[], hasNextPage = false) =>
    graphql({
      repository: {
        id: "R_node",
        nameWithOwner: "o/p",
        ref: { associatedPullRequests: { pageInfo: { hasNextPage }, nodes } },
      },
    });

  it("管理 branch の Open PR を返し、branch がなければ空にする", async () => {
    const found = createFetcher({
      "POST /graphql": managed([
        { number: 3, title: "t", baseRefName: "main", repository: { id: "R_node" }, body: "b" },
        { number: 3, title: "upstream", baseRefName: "main", repository: { id: "R_upstream" }, body: "b" },
      ]),
    });
    await expect(found.gateway.readManagedPullRequests("o/p", "flightdeck-dispatch/a/src")).resolves.toEqual({
      fullName: "o/p",
      pullRequests: [{ number: 3, title: "t", baseBranch: "main", body: "b" }],
    });
    expect(found.requests[0]?.body).toMatchObject({ variables: { ref: "refs/heads/flightdeck-dispatch/a/src" } });

    const none = createFetcher({
      "POST /graphql": graphql({ repository: { id: "R_node", nameWithOwner: "o/p", ref: null } }),
    });
    await expect(none.gateway.readManagedPullRequests("o/p", "h")).resolves.toEqual({
      fullName: "o/p",
      pullRequests: [],
    });
  });

  it("PR が 1 ページに収まらなければ undeterminable にする", async () => {
    const { gateway } = createFetcher({ "POST /graphql": managed([], true) });

    await expect(gateway.readManagedPullRequests("o/p", "h")).rejects.toMatchObject({ kind: "undeterminable" });
  });
});

describe("GraphQL 読み取りのエラー分類", () => {
  const failing = (errors: unknown) =>
    createFetcher({ "POST /graphql": graphql({ repository: null }, errors) }).gateway.readManagedPullRequests(
      "o/p",
      "h"
    );

  it("type に従って分類する", async () => {
    await expect(failing([{ type: "RATE_LIMITED", message: "x" }])).rejects.toMatchObject({
      kind: "retryable",
      retryAfterSeconds: 60,
    });
    await expect(failing([{ type: "FORBIDDEN", message: "x" }])).rejects.toMatchObject({ kind: "permission" });
    await expect(failing([{ type: "NOT_FOUND", message: "x" }])).rejects.toMatchObject({
      kind: "permission",
      message: expect.stringContaining("may not have access") as unknown,
    });
    // timeout などは type なしで返る
    await expect(failing([{ message: "something" }])).rejects.toMatchObject({ kind: "retryable" });
    await expect(failing([{ type: "SOMETHING_ELSE", message: "x" }])).rejects.toMatchObject({ kind: "retryable" });
  });
});

describe("API エラーの分類", () => {
  const getRepository = (response: () => Response) =>
    createFetcher({ "POST /repos/o/p/git/commits": response }).gateway.createCommit("o/p", {
      treeSha: "T",
      parentSha: "B",
      message: "m",
    });

  it("429 は Retry-After を尊重して retryable にする", async () => {
    await expect(
      getRepository(() => new Response("", { status: 429, headers: { "retry-after": "42" } }))
    ).rejects.toMatchObject({
      kind: "retryable",
      retryAfterSeconds: 42,
    });
  });

  it("secondary rate limit は Retry-After がなくても、本文から判定して retryable にする", async () => {
    await expect(
      getRepository(() => new Response('{"message":"You have exceeded a secondary rate limit."}', { status: 403 }))
    ).rejects.toMatchObject({ kind: "retryable", retryAfterSeconds: 60 });
  });

  it("Retry-After 付きの 403 は retryable、権限の 403 は permission", async () => {
    await expect(
      getRepository(() => new Response("", { status: 403, headers: { "retry-after": "10" } }))
    ).rejects.toMatchObject({
      kind: "retryable",
      retryAfterSeconds: 10,
    });
    await expect(getRepository(() => new Response("", { status: 403 }))).rejects.toMatchObject({ kind: "permission" });
  });

  it("5xx は retryable、通信エラーも retryable", async () => {
    await expect(getRepository(() => new Response("", { status: 502 }))).rejects.toMatchObject({ kind: "retryable" });
    const gateway = new GitHubGatewayImpl({
      fetcher: () => Promise.reject(new Error("network down")),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.createCommit("o/p", { treeSha: "T", parentSha: "B", message: "m" })).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it("404 は、App がその repository に入っていない可能性を示す permission エラーにする", async () => {
    await expect(getRepository(() => new Response("", { status: 404 }))).rejects.toMatchObject({
      kind: "permission",
      message: expect.stringContaining("may not have access") as unknown,
    });
  });

  it("422 は retryable（PR の作成が競合しても、再実行で状態を読み直せる）", async () => {
    await expect(getRepository(() => new Response("", { status: 422 }))).rejects.toMatchObject({ kind: "retryable" });
  });

  it("JSON として読めない応答は、本文を含めず retryable にする", async () => {
    await expect(getRepository(() => new Response("<html>secret-page</html>", { status: 200 }))).rejects.toMatchObject({
      kind: "retryable",
      message: "invalid JSON response",
    });
  });

  it("エラー本文を message に含めない", async () => {
    await expect(getRepository(() => new Response("secret-body", { status: 422 }))).rejects.not.toThrow(/secret-body/);
  });
});
