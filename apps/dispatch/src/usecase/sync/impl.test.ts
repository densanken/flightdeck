import { describe, expect, it } from "vitest";

import { SyncUseCaseImpl } from "./impl.js";
import { DispatchError, isPermanent } from "../../errors.js";

import type {
  ChildMessage,
  DispatchGateway,
  OpenPullRequest,
  ParentState,
  RefUpdateResult,
  RepositoryInfo,
  RepositoryState,
} from "./dependencies.js";
import type { Submodule } from "../../domain/gitmodules.js";
import type { LogRecord } from "../../util/logger.js";
import type { ConfigFile } from "@flightdeck/rules";

const BRANCH = "flightdeck-dispatch/o/src";
const TITLE = "chore(submodule): update o/src";

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("fixture is missing");
  return value;
};

interface FakeCommit {
  tree: string;
  parents: string[];
  message: string;
  // YAML の本文
  // オブジェクトを渡すと JSON（YAML の一部）にする
  config: string | null | undefined;
  // flightdeck.yaml の本文
  yamlConfig: string | null | undefined;
  gitmodules: Submodule[] | undefined;
}

interface FakeRepo {
  info: RepositoryInfo;
  branches: Map<string, string>;
}

interface FakePull extends OpenPullRequest {
  repository: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
  // Close 済みなら Close したときの head（Open なら branch の今の head を使う）
  headSha?: string;
  // Close した順（Close していなければ undefined）
  closedOrder?: number;
}

// GitHub のうち use case が使う範囲だけを再現するメモリ上の実装
// tree は gitlink の path と SHA の組だけを持ち、内容が同じなら同じ SHA になる
class FakeGitHub implements DispatchGateway {
  repos = new Map<string, FakeRepo>();
  commits = new Map<string, FakeCommit>();
  trees = new Map<string, Record<string, string>>();
  pulls: FakePull[] = [];
  children: ChildMessage[] = [];
  calls: (keyof DispatchGateway)[] = [];
  refUpdates: { branch: string; before: string | undefined; after: string }[] = [];
  remainingConflicts = 0;
  failures: Partial<Record<keyof DispatchGateway, DispatchError>> = {};
  failOnce = new Set<keyof DispatchGateway>();
  // reopenPullRequest が GitHub に拒否される
  rejectReopen = false;
  afterRefUpdate: (() => void) | undefined;
  beforeRefUpdate: (() => void) | undefined;
  afterParentState: (() => void) | undefined;
  afterRepositoryState: (() => void) | undefined;
  previousRequests: ({ sha: string } | { branch: string } | undefined)[] = [];
  managedOverflow = false;
  private counter = 0;

  addRepo(fullName: string, defaultBranch: string): void {
    this.repos.set(fullName.toLowerCase(), {
      info: { fullName, defaultBranch, isPrivate: false },
      branches: new Map(),
    });
  }

  commit(
    repository: string,
    branch: string,
    spec: {
      gitlinks?: Record<string, string>;
      config?: unknown;
      yamlConfig?: unknown;
      gitmodules?: Submodule[];
      parents?: string[];
      message?: string;
    } = {}
  ): string {
    const repo = this.repo(repository);
    const previous = repo.branches.get(branch);
    const parents = spec.parents ?? (previous ? [previous] : []);
    const parent = parents[0] ? this.commits.get(parents[0]) : undefined;
    const gitlinks = spec.gitlinks ?? (parent ? this.trees.get(parent.tree) : undefined) ?? {};
    const sha = `${repository}@${String(++this.counter)}`;
    const config = "config" in spec ? spec.config : parent?.config;
    const yamlConfig = "yamlConfig" in spec ? spec.yamlConfig : parent?.yamlConfig;
    // null は、切り詰められたりバイナリだったりして読めないファイル
    const asText = (value: unknown): string | null | undefined =>
      typeof value === "string" || value === null || value === undefined ? value : JSON.stringify({ dispatch: value });
    this.commits.set(sha, {
      tree: this.storeTree(gitlinks),
      parents,
      message: spec.message ?? "commit",
      config: asText(config),
      yamlConfig: asText(yamlConfig),
      gitmodules: spec.gitmodules ?? parent?.gitmodules,
    });
    repo.branches.set(branch, sha);
    return sha;
  }

  addPull(repository: string, pull: Partial<FakePull> = {}): number {
    const number = ++this.counter;
    this.pulls.push({
      repository,
      state: "open",
      number,
      title: TITLE,
      baseBranch: "main",
      body: "",
      headBranch: BRANCH,
      ...pull,
    });
    return number;
  }

  gitlinks(repository: string, branch: string): Record<string, string> | undefined {
    const sha = this.repo(repository).branches.get(branch);
    const commit = sha ? this.commits.get(sha) : undefined;
    return commit ? this.trees.get(commit.tree) : undefined;
  }

  head(repository: string, branch: string): { sha: string; commit: FakeCommit } {
    const sha = this.repo(repository).branches.get(branch) ?? "";
    return { sha, commit: must(this.commits.get(sha)) };
  }

  // 最後に Close された PR（Open の PR があれば undefined）
  private lastClosedPull(repository: string, head: string): ParentState["lastClosedPullRequest"] {
    const pulls = this.pulls.filter(
      (candidate) => candidate.repository === repository && candidate.headBranch === head
    );
    if (pulls.some((pull) => pull.state === "open")) return undefined;
    const pull = pulls.sort((a, b) => (a.closedOrder ?? 0) - (b.closedOrder ?? 0)).at(-1);
    return pull
      ? { number: pull.number, title: pull.title, merged: pull.state === "merged", headSha: pull.headSha ?? "" }
      : undefined;
  }

  openPulls(repository: string): FakePull[] {
    return this.pulls.filter((pull) => pull.repository === repository && pull.state === "open");
  }

  // 最初の親との tree の差を、変更されたファイルの数として数える（gitlink だけを持つ fake の tree で足りる）
  private changedFiles(commit: FakeCommit): number {
    const parent = commit.parents[0] ? this.commits.get(commit.parents[0]) : undefined;
    const before = (parent ? this.trees.get(parent.tree) : undefined) ?? {};
    const after = this.trees.get(commit.tree) ?? {};
    const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...paths].filter((path) => before[path] !== after[path]).length;
  }

  private repo(repository: string): FakeRepo {
    const repo = this.repos.get(repository.toLowerCase());
    if (!repo) throw new DispatchError("permission", `not installed: ${repository}`);
    return repo;
  }

  private storeTree(gitlinks: Record<string, string>): string {
    const sorted = Object.fromEntries(Object.entries(gitlinks).sort(([a], [b]) => a.localeCompare(b)));
    const sha = `tree:${JSON.stringify(sorted)}`;
    this.trees.set(sha, sorted);
    return sha;
  }

  private resolve(repository: string, ref: string): string | undefined {
    const branch = ref.replace(/^refs\/heads\//, "");
    return this.repo(repository).branches.get(branch) ?? (this.commits.has(ref) ? ref : undefined);
  }

  private enter(name: keyof DispatchGateway): void {
    this.calls.push(name);
    const failure = this.failures[name];
    if (failure) {
      if (this.failOnce.has(name)) this.failures[name] = undefined;
      throw failure;
    }
  }

  getBranchHead(repository: string, branch: string): Promise<string | undefined> {
    this.enter("getBranchHead");
    return Promise.resolve(this.repo(repository).branches.get(branch));
  }

  readRepositoryState(
    repository: string,
    options?: { previous?: { sha: string } | { branch: string }; withManaged?: boolean }
  ): Promise<RepositoryState> {
    const requested = options?.previous;
    const previousRef =
      requested === undefined ? undefined : "sha" in requested ? requested.sha : `refs/heads/${requested.branch}`;
    this.enter("readRepositoryState");
    const repo = this.repo(repository);
    const sha = repo.branches.get(repo.info.defaultBranch);
    const filesAt = (commitSha: string | undefined): ConfigFile[] => {
      const commit = commitSha ? this.commits.get(commitSha) : undefined;
      return [
        { path: ".github/flightdeck.yml", text: commit?.config },
        { path: ".github/flightdeck.yaml", text: commit?.yamlConfig },
      ].filter((file): file is ConfigFile => file.text !== undefined);
    };
    this.previousRequests.push(requested);
    this.afterRepositoryState?.();
    let previous: RepositoryState["previous"];
    if (previousRef !== undefined) {
      const previousSha = this.resolve(repository, previousRef);
      if (previousSha) previous = { configs: filesAt(previousSha) };
    }
    let managed: RepositoryState["managed"] = [];
    if (this.managedOverflow) {
      managed = "overflow";
    } else if (options?.withManaged) {
      const heads = new Set(
        this.openPulls(repository)
          .filter((pull) => pull.headBranch.startsWith("flightdeck-dispatch/"))
          .map((pull) => pull.headBranch)
      );
      managed = [...heads].map((head) => ({
        head,
        baseBranches: this.openPulls(repository)
          .filter((pull) => pull.headBranch === head)
          .map((pull) => pull.baseBranch),
      }));
    }
    return Promise.resolve({ repository: repo.info, sha, configs: filesAt(sha), previous, managed });
  }

  readParentState(
    repository: string,
    input: { baseBranch: string | undefined; head: string; path: string }
  ): Promise<ParentState> {
    this.enter("readParentState");
    const repo = this.repo(repository);
    const baseBranch = input.baseBranch ?? repo.info.defaultBranch;
    const baseSha = repo.branches.get(baseBranch);
    const baseCommit = baseSha ? this.commits.get(baseSha) : undefined;
    const headSha = repo.branches.get(input.head);
    const headCommit = headSha ? this.commits.get(headSha) : undefined;
    const state: ParentState = {
      repository: repo.info,
      base:
        baseSha && baseCommit
          ? {
              branch: baseBranch,
              sha: baseSha,
              treeSha: baseCommit.tree,
              gitlinkSha: this.trees.get(baseCommit.tree)?.[input.path],
              submodules: baseCommit.gitmodules ?? [],
            }
          : undefined,
      branch:
        headSha && headCommit
          ? {
              sha: headSha,
              parentShas: headCommit.parents,
              message: headCommit.message,
              gitlinkSha: this.trees.get(headCommit.tree)?.[input.path],
              changedFiles: this.changedFiles(headCommit),
            }
          : undefined,
      pullRequests: this.openPulls(repo.info.fullName).filter((pull) => pull.headBranch === input.head),
      lastClosedPullRequest: this.lastClosedPull(repo.info.fullName, input.head),
    };
    this.afterParentState?.();
    return Promise.resolve(state);
  }

  readManagedPullRequests(
    repository: string,
    head: string
  ): Promise<{ fullName: string; pullRequests: OpenPullRequest[] }> {
    this.enter("readManagedPullRequests");
    return Promise.resolve({
      fullName: this.repo(repository).info.fullName,
      pullRequests: this.openPulls(repository).filter((pull) => pull.headBranch === head),
    });
  }

  checkUnchanged(input: {
    source: { repository: string; defaultBranch: string; sha: string };
    parent: { repository: string; branch: string; sha: string };
  }): Promise<boolean> {
    this.enter("checkUnchanged");
    const source = this.repo(input.source.repository);
    const sourceOk =
      source.info.defaultBranch === input.source.defaultBranch &&
      source.branches.get(source.info.defaultBranch) === input.source.sha;
    const parentOk = this.repo(input.parent.repository).branches.get(input.parent.branch) === input.parent.sha;
    return Promise.resolve(sourceOk && parentOk);
  }

  createPullRequest(
    repository: string,
    input: { head: string; base: string; title: string; body: string }
  ): Promise<void> {
    this.enter("createPullRequest");
    this.addPull(repository, { headBranch: input.head, baseBranch: input.base, title: input.title, body: input.body });
    return Promise.resolve();
  }

  updatePullRequest(
    repository: string,
    number: number,
    patch: { baseBranch?: string; title?: string; body?: string; closed?: boolean }
  ): Promise<void> {
    this.enter("updatePullRequest");
    const pull = this.pulls.find((candidate) => candidate.repository === repository && candidate.number === number);
    if (!pull) throw new Error("pull request not found");
    if (patch.baseBranch !== undefined) pull.baseBranch = patch.baseBranch;
    if (patch.title !== undefined) pull.title = patch.title;
    if (patch.body !== undefined) pull.body = patch.body;
    if (patch.closed) {
      pull.state = "closed";
      pull.headSha = this.repo(repository).branches.get(pull.headBranch);
      pull.closedOrder = ++this.counter;
    }
    return Promise.resolve();
  }

  // GitHub と同じく、Close 中に head が動いた PR は Open に戻せない
  reopenPullRequest(repository: string, number: number, title: string): Promise<boolean> {
    this.enter("reopenPullRequest");
    const pull = this.pulls.find((candidate) => candidate.repository === repository && candidate.number === number);
    if (!pull) throw new Error("pull request not found");
    if (this.rejectReopen || this.repo(repository).branches.get(pull.headBranch) !== pull.headSha) {
      return Promise.resolve(false);
    }
    pull.state = "open";
    pull.title = title;
    return Promise.resolve(true);
  }

  // head から最初の親をたどり、base に着くまでの commit を古い順に返す
  // 失敗は、実際の gateway と同じく reject で返す
  compareCommits(
    _repository: string,
    base: string,
    head: string
  ): Promise<{ commits: { sha: string; subject: string }[]; total: number } | undefined> {
    return Promise.resolve().then(() => {
      this.enter("compareCommits");
      const commits: { sha: string; subject: string }[] = [];
      for (let sha: string | undefined = head; sha !== undefined; sha = this.commits.get(sha)?.parents[0]) {
        if (sha === base) return { commits, total: commits.length };
        commits.unshift({ sha, subject: this.commits.get(sha)?.message ?? "" });
      }
      return undefined;
    });
  }

  createGitlinkTree(
    _repository: string,
    input: { baseTreeSha: string; path: string; gitlinkSha: string }
  ): Promise<string> {
    this.enter("createGitlinkTree");
    return Promise.resolve(this.storeTree({ ...this.trees.get(input.baseTreeSha), [input.path]: input.gitlinkSha }));
  }

  createCommit(repository: string, input: { treeSha: string; parentSha: string; message: string }): Promise<string> {
    this.enter("createCommit");
    const sha = `${repository}@${String(++this.counter)}`;
    this.commits.set(sha, {
      tree: input.treeSha,
      parents: [input.parentSha],
      message: input.message,
      config: undefined,
      yamlConfig: undefined,
      gitmodules: undefined,
    });
    return Promise.resolve(sha);
  }

  updateRef(
    repository: string,
    branch: string,
    input: { before: string | undefined; after: string }
  ): Promise<RefUpdateResult> {
    this.enter("updateRef");
    this.beforeRefUpdate?.();
    const repo = this.repo(repository);
    if (this.remainingConflicts > 0) {
      this.remainingConflicts -= 1;
      return Promise.resolve("conflict");
    }
    if (repo.branches.get(branch) !== input.before) return Promise.resolve("conflict");
    repo.branches.set(branch, input.after);
    this.refUpdates.push({ branch, before: input.before, after: input.after });
    this.afterRefUpdate?.();
    return Promise.resolve("updated");
  }
}

const gitmodules = (path: string, source = "o/src"): Submodule[] => [{ path, url: `https://github.com/${source}.git` }];

// Queue の処理を再現する
// 最初の message を処理し、積まれた子 message を順に処理する
// 恒久的な失敗は consume と同じく記録して続行し、再実行で直る失敗は最後に最初の 1 件を投げる
// 恒久的な失敗か再実行で直る失敗かの分け方は、handler の consume と同じ isPermanent を使う
const setup = (config: unknown = { targets: [{ repository: "o/parent", path: "contents" }] }) => {
  const gh = new FakeGitHub();
  gh.addRepo("o/src", "main");
  gh.addRepo("o/parent", "main");
  const parentBase = gh.commit("o/parent", "main", {
    gitlinks: { contents: "old-sha", other: "keep-sha" },
    gitmodules: gitmodules("contents"),
  });
  const sourceHead = gh.commit("o/src", "main", { config });
  const logs: LogRecord[] = [];
  const enqueued: ChildMessage[] = [];
  const useCase = new SyncUseCaseImpl({
    gateway: gh,
    enqueue: (messages) => {
      enqueued.push(...messages);
      gh.children.push(...messages);
      return Promise.resolve();
    },
    logger: { log: (_level, record) => logs.push(record) },
  });
  const dispatch = (message: ChildMessage): Promise<void> =>
    message.event === "sync-target" ? useCase.syncTarget(message) : useCase.closeTarget(message);
  const drain = async (start: () => Promise<void>): Promise<void> => {
    let retryable: Error | undefined;
    const guard = async (run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        if (isPermanent(error)) {
          logs.push({ event: "sync_failed", kind: error.kind, errorMessage: error.message });
        } else {
          retryable ??= error instanceof Error ? error : new Error(String(error));
        }
      }
    };
    await guard(start);
    for (let child = gh.children.shift(); child; child = gh.children.shift()) {
      const message = child;
      await guard(() => dispatch(message));
    }
    if (retryable) throw retryable;
  };
  const push = (repository = "o/src", branch = "main", before?: string) =>
    drain(() => useCase.handlePush({ repository, branch, before }));
  const changeDefault = (repository: string, previousDefaultBranch: string) =>
    drain(() => useCase.handleDefaultBranchChanged({ repository, previousDefaultBranch }));
  return { gh, logs, enqueued, useCase, push, changeDefault, drain, dispatch, parentBase, sourceHead };
};

describe("子 message の積み込み", () => {
  it("source の push は読み取りだけを行い、target ごとと削除された target ごとの子 message を積む", async () => {
    const { gh, enqueued, useCase, sourceHead } = setup({
      targets: [
        { repository: "o/parent", path: "contents" },
        { repository: "o/second", path: "lib" },
      ],
    });
    gh.commit("o/src", "main", { config: { targets: [{ repository: "o/parent", path: "contents" }] } });
    const previous = gh.commit("o/src", "main", {
      config: {
        targets: [
          { repository: "o/parent", path: "contents" },
          { repository: "o/second", path: "lib" },
        ],
      },
    });
    gh.commit("o/src", "main", { config: { targets: [{ repository: "o/parent", path: "contents" }] } });

    await useCase.handlePush({ repository: "o/src", branch: "main", before: previous });

    expect(enqueued).toEqual([
      { event: "sync-target", source: "o/src", target: "o/parent" },
      { event: "close-target", source: "o/src", target: "o/second" },
    ]);
    expect(gh.calls.filter((call) => call !== "readRepositoryState")).toEqual([]);
    expect(sourceHead).toBeTruthy();
  });

  it("parent の push は、push された branch を base とする Open PR を持つ管理 branch ごとに、子 message を積む", async () => {
    const { gh, enqueued, useCase } = setup();
    gh.addPull("o/parent", { headBranch: "flightdeck-dispatch/a/one", baseBranch: "main" });
    gh.addPull("o/parent", { headBranch: "flightdeck-dispatch/a/one", baseBranch: "main" });
    gh.addPull("o/parent", { headBranch: "flightdeck-dispatch/b/two", baseBranch: "develop" });
    gh.addPull("o/parent", { headBranch: "feature/unrelated", baseBranch: "main" });

    await useCase.handlePush({ repository: "o/parent", branch: "main" });

    // parent の push では、管理 branch 名から戻した source ごとに、parent の同期を積む
    expect(enqueued).toEqual([{ event: "sync-target", source: "a/one", target: "o/parent" }]);
  });

  it("default branch の変更では、base に関係なく、Open PR を持つ管理 branch すべての子 message を積む", async () => {
    const { gh, enqueued, useCase } = setup();
    gh.addPull("o/parent", { headBranch: "flightdeck-dispatch/a/one", baseBranch: "main" });
    gh.addPull("o/parent", { headBranch: "flightdeck-dispatch/b/two", baseBranch: "develop" });

    await useCase.handleDefaultBranchChanged({ repository: "o/parent", previousDefaultBranch: "main" });

    expect(enqueued).toEqual([
      { event: "sync-target", source: "a/one", target: "o/parent" },
      { event: "sync-target", source: "b/two", target: "o/parent" },
    ]);
  });

  it("管理 branch が多すぎて信用できなければ、parent の役割だけが失敗し、source の役割は進める", async () => {
    const { gh, enqueued, useCase, logs } = setup();
    gh.managedOverflow = true;

    await useCase.handlePush({ repository: "o/src", branch: "main" });

    expect(enqueued).toEqual([{ event: "sync-target", source: "o/src", target: "o/parent" }]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "sync_failed",
        kind: "undeterminable",
        errorMessage: expect.stringContaining("managed") as unknown,
      })
    );
  });

  it("子 message を処理する時点の設定で動く。設定から外れた target の子 message は、何も更新しない", async () => {
    const { gh, useCase } = setup();
    gh.commit("o/src", "main", { config: { targets: [] } });

    await useCase.syncTarget({ source: "o/src", target: "o/parent" });

    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
  });
});

describe("共有の設定ファイル（flightdeck.yml と flightdeck.yaml）", () => {
  const withParent = { targets: [{ repository: "o/parent", path: "contents" }] };

  it(".yaml だけでも、設定として読んで同期する", async () => {
    const { gh, push } = setup();
    const yamlHead = gh.commit("o/src", "main", { config: undefined, yamlConfig: withParent });

    await push();

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(yamlHead);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it(".yml を .yaml に改名しても、target の削除とは見なさず、PR を Close しない", async () => {
    const { gh, push, enqueued } = setup();
    await push();
    const before = gh.head("o/src", "main").sha;
    gh.commit("o/src", "main", { config: undefined, yamlConfig: withParent });
    enqueued.length = 0;

    await push("o/src", "main", before);

    expect(enqueued).toEqual([{ event: "sync-target", source: "o/src", target: "o/parent" }]);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
    // 本文の注記は、改名後の設定ファイルへ link する
    expect(gh.openPulls("o/parent")[0]?.body).toContain("/.github/flightdeck.yaml)");
  });

  it("現在の設定が読めない（切り詰められた、バイナリ）ときは、source の役割だけを設定エラーで止め、何も積まない", async () => {
    const { gh, push, logs, enqueued, sourceHead } = setup();
    gh.addPull("o/parent");
    gh.commit("o/src", "main", { config: null });

    await push("o/src", "main", sourceHead);

    expect(enqueued).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "sync_failed",
        kind: "config",
        errorMessage: "flightdeck config cannot be read",
      })
    );
  });

  it("close-target を積んでから処理するまでの間に、最新の設定が読めなくなる、または両方になったら、何も Close しない", async () => {
    const { gh, useCase, sourceHead } = setup();
    const withParent = { targets: [{ repository: "o/parent", path: "contents" }] };
    const number = gh.addPull("o/parent");
    expect(sourceHead).toBeTruthy();
    const closeTarget = () => useCase.closeTarget({ source: "o/src", target: "o/parent" });

    // 設定から parent を外す
    gh.commit("o/src", "main", { config: { targets: [] } });

    // 処理の直前の設定が読めない
    gh.commit("o/src", "main", { config: null });
    await expect(closeTarget()).rejects.toMatchObject({ kind: "config" });

    // 処理の直前の設定が両方ある
    gh.commit("o/src", "main", { config: withParent, yamlConfig: withParent });
    await expect(closeTarget()).rejects.toMatchObject({ kind: "config" });

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
  });

  it("dispatch の section がない共有ファイルでは、source_skipped を記録する", async () => {
    const { gh, push, logs } = setup();
    gh.commit("o/src", "main", { config: "takeoff: {}\n" });

    await push();

    expect(logs).toContainEqual(expect.objectContaining({ event: "source_skipped", reason: "no config" }));
  });

  it("旧設定が読めないときは、前の target の PR を Close せず、cleanup_skipped を記録して現在の設定を適用する", async () => {
    const { gh, push, logs, enqueued } = setup();
    const unreadable = gh.commit("o/src", "main", { config: null });
    gh.commit("o/src", "main", { config: { targets: [] } });
    gh.addPull("o/parent");

    await push("o/src", "main", unreadable);

    expect(enqueued.filter((message) => message.event === "close-target")).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "cleanup_skipped" }));
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("共有ファイルから dispatch の section を消すと、ファイルを消したときと同じく、前の target の PR を Close する", async () => {
    const { gh, push, sourceHead } = setup();
    const number = gh.addPull("o/parent");
    gh.commit("o/src", "main", { config: "preflight:\n  enabled: true\n" });

    await push("o/src", "main", sourceHead);

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("closed");
  });

  it("dispatch の key がない共有ファイルだけの repo は、source として扱わず、何も積まない", async () => {
    const { gh, push, enqueued, logs } = setup();
    gh.commit("o/src", "main", { config: "takeoff: {}\n" });

    await push();

    expect(enqueued).toEqual([]);
    expect(logs.filter((log) => log.event === "sync_failed")).toEqual([]);
  });

  it("他の app の section があっても、dispatch の section だけで同期する", async () => {
    const { gh, push } = setup();
    const head = gh.commit("o/src", "main", {
      config: "preflight:\n  anything: 1\ndispatch:\n  targets:\n    - repository: o/parent\n      path: contents\n",
    });

    await push();

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(head);
  });

  it("両方あると、設定エラーとして source の役割だけを止め、parent の役割は進める", async () => {
    const { gh, push, logs, enqueued } = setup();
    gh.commit("o/src", "main", { config: withParent, yamlConfig: withParent });
    gh.addPull("o/src", { headBranch: "flightdeck-dispatch/a/one", baseBranch: "main" });

    await push();

    expect(enqueued).toEqual([{ event: "sync-target", source: "a/one", target: "o/src" }]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "sync_failed",
        kind: "config",
        errorMessage: "both flightdeck.yml and flightdeck.yaml exist",
      })
    );
    expect(gh.refUpdates).toEqual([]);
  });

  it("子 message の処理で両方あれば、何も更新しない", async () => {
    const { gh, useCase } = setup();
    gh.commit("o/src", "main", { config: withParent, yamlConfig: withParent });

    await expect(useCase.syncTarget({ source: "o/src", target: "o/parent" })).rejects.toMatchObject({
      kind: "config",
    });
    expect(gh.refUpdates).toEqual([]);
  });

  it("旧設定が両方あれば、使えない旧設定として cleanup_skipped を記録し、現在の設定は適用する", async () => {
    const { gh, push, logs } = setup();
    const both = gh.commit("o/src", "main", { config: withParent, yamlConfig: withParent });
    gh.commit("o/src", "main", { config: withParent, yamlConfig: undefined });

    await push("o/src", "main", both);

    expect(logs).toContainEqual(expect.objectContaining({ event: "cleanup_skipped" }));
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });
});

describe("source の push", () => {
  it("初回 push で管理 branch と通常 PR を作成し、gitlink 以外を変更しない", async () => {
    const { gh, push, parentBase, sourceHead } = setup();

    await push();

    const { commit } = gh.head("o/parent", BRANCH);
    expect(commit.parents).toEqual([parentBase]);
    expect(commit.message).toBe(TITLE);
    expect(gh.trees.get(commit.tree)).toEqual({ contents: sourceHead, other: "keep-sha" });
    expect(gh.refUpdates).toEqual([{ branch: BRANCH, before: undefined, after: gh.head("o/parent", BRANCH).sha }]);
    expect(gh.openPulls("o/parent")).toMatchObject([{ baseBranch: "main", headBranch: BRANCH, title: TITLE }]);
  });

  it("1 つの source から複数の parent を独立して同期し、一方の設定エラーが他方に影響しない", async () => {
    const { gh, push, sourceHead } = setup({
      targets: [
        { repository: "o/broken", path: "contents" },
        { repository: "o/parent", path: "contents" },
        { repository: "o/second", path: "lib" },
      ],
    });
    gh.addRepo("o/broken", "main");
    gh.commit("o/broken", "main", { gitlinks: {}, gitmodules: gitmodules("contents") });
    gh.addRepo("o/second", "main");
    gh.commit("o/second", "main", { gitlinks: { lib: "old" }, gitmodules: gitmodules("lib") });

    await push();

    expect(gh.openPulls("o/broken")).toEqual([]);
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(sourceHead);
    expect(gh.gitlinks("o/second", BRANCH)?.lib).toBe(sourceHead);
  });

  it("既存の Open PR は番号を維持したまま、新しい source SHA へ branch を更新する", async () => {
    const { gh, push } = setup();
    await push();
    const [first] = gh.openPulls("o/parent");

    const newer = gh.commit("o/src", "main");
    await push();

    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(gh.openPulls("o/parent")[0]?.number).toBe(first?.number);
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(newer);
  });

  it("既存の Open PR の本文を、現在の状態から作った本文と違うときだけ書き換える", async () => {
    const { gh, push, sourceHead } = setup();
    await push();
    // base の gitlink から source の HEAD までの commit を一覧にする
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
    const newer = gh.commit("o/src", "main", { message: "add post" });

    await push();
    const [pull] = gh.openPulls("o/parent");
    expect(pull?.body).toContain(`/commit/${newer}`);
    expect(pull?.body).toContain("` add post `");
    // 注記は、target を読んだ設定ファイルへ link する
    expect(pull?.body).toContain(`/blob/${newer}/.github/flightdeck.yml)`);

    // 同じ状態なら書き換えず、手で編集された本文は次の同期で戻す
    const written = pull?.body;
    const updates = () => gh.calls.filter((call) => call === "updatePullRequest").length;
    const before = updates();
    await push();
    expect(updates()).toBe(before);
    if (pull) pull.body = "edited";
    await push();
    expect(pull?.body).toBe(written);
  });

  it("commit の一覧を取得できなくても、一覧なしの本文で PR を作成する", async () => {
    const { gh, push, logs } = setup();
    gh.failures.compareCommits = new DispatchError("retryable", "compare timed out");

    await push();

    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(gh.openPulls("o/parent")[0]?.body).not.toContain("<details>");
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "compare_failed", errorMessage: "compare timed out" })
    );
  });

  it("commit の一覧を取得できなくても、source が進んだら、新しい SHA の本文に書き換える（一覧は載せない）", async () => {
    const { gh, push, sourceHead } = setup();
    // base の gitlink を source の commit にして、1 回目の本文に一覧を載せる
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
    gh.commit("o/src", "main");
    await push();
    const pull = must(gh.openPulls("o/parent")[0]);
    expect(pull.body).toContain("<details>");
    const latest = gh.commit("o/src", "main");
    gh.failures.compareCommits = new DispatchError("retryable", "compare timed out");

    await push();

    expect(pull.body).toContain(`/commit/${latest}`);
    expect(pull.body).not.toContain("<details>");
  });

  it("commit の一覧を取得できず、source も base branch も変わらなければ、一覧のある既存の本文を残す", async () => {
    const { gh, push, sourceHead } = setup();
    // base の gitlink を source の commit にして、一覧を作れるようにする
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
    gh.commit("o/src", "main");
    await push();
    const pull = must(gh.openPulls("o/parent")[0]);
    const written = pull.body;
    gh.failures.compareCommits = new DispatchError("retryable", "compare timed out");

    await push();

    expect(written).toContain("<details>");
    expect(pull.body).toBe(written);
  });

  it.each([
    ["公開 parent", false, "含まれるコミット: 1 件"],
    ["非公開 parent", true, "secret subject"],
  ])(
    "非公開 source から %s では、commit の一覧を取得できなくても、既存の本文を残す",
    async (_, parentPrivate, shown) => {
      const { gh, push, sourceHead } = setup();
      must(gh.repos.get("o/src")).info.isPrivate = true;
      must(gh.repos.get("o/parent")).info.isPrivate = parentPrivate;
      gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
      gh.commit("o/src", "main", { message: "secret subject" });
      await push();
      const pull = must(gh.openPulls("o/parent")[0]);
      const written = pull.body;
      gh.failures.compareCommits = new DispatchError("retryable", "compare timed out");

      await push();

      expect(written).toContain(shown);
      expect(pull.body).toBe(written);
    }
  );

  it("commit の一覧を取得できなくても、一覧の外が手で編集された本文は書き換える", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
    gh.commit("o/src", "main");
    await push();
    const pull = must(gh.openPulls("o/parent")[0]);
    pull.body = `edited\n${pull.body}`;
    gh.failures.compareCommits = new DispatchError("retryable", "compare timed out");

    await push();

    expect(pull.body).not.toContain("edited");
    expect(pull.body).not.toContain("<details>");
  });

  it("手で Open に戻された PR の title に残った suffix を外す", async () => {
    const { gh, push } = setup();
    const number = gh.addPull("o/parent", { title: `${TITLE} - autoclosed` });

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)?.title).toBe(TITLE);
  });

  it("source が force push で巻き戻っても、祖先を判定せず新しい HEAD へ追従する", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/src", "main");
    await push();

    gh.repos.get("o/src")?.branches.set("main", sourceHead);
    await push();

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(sourceHead);
  });

  it("同じ event を再送しても commit も PR も増やさない", async () => {
    const { gh, push } = setup();
    await push();
    const commitCount = gh.commits.size;
    const refUpdateCount = gh.refUpdates.length;

    await push();

    expect(gh.commits.size).toBe(commitCount);
    // すでに最新なら tree も作らない
    expect(gh.calls.filter((call) => call === "createGitlinkTree")).toHaveLength(1);
    expect(gh.refUpdates).toHaveLength(refUpdateCount);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("default branch 以外の push では source として同期しない", async () => {
    const { gh, push } = setup();
    gh.commit("o/src", "topic");

    await push("o/src", "topic");

    expect(gh.refUpdates).toEqual([]);
  });

  it("設定がなく source として扱わない repo では、cleanup_skipped を記録しない", async () => {
    const { gh, push, logs } = setup();
    gh.commit("o/src", "main", { config: undefined });

    await push("o/src", "main", "0".repeat(40));

    expect(logs.filter((log) => log.event === "cleanup_skipped")).toEqual([]);
  });

  it("設定がない repo の push では何も作らない", async () => {
    const { gh, push } = setup({ targets: [] });
    gh.commit("o/src", "main", { config: undefined });

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
  });

  it("管理 branch が手動 commit で変更されていたら、次の同期で破棄して再生成する", async () => {
    const { gh, push, parentBase } = setup();
    await push();
    const manual = gh.commit("o/parent", BRANCH, { gitlinks: { contents: "manual", extra: "x" } });

    await push();

    const { commit, sha } = gh.head("o/parent", BRANCH);
    expect(commit.parents).toEqual([parentBase]);
    expect(gh.trees.get(commit.tree)).not.toHaveProperty("extra");
    expect(gh.refUpdates.at(-1)).toEqual({ branch: BRANCH, before: manual, after: sha });
  });

  it("以前の PR が merge または Close 済みで branch だけが残っていても、再利用して新規 PR を作る", async () => {
    const { gh, push } = setup();
    const leftover = gh.commit("o/parent", BRANCH, { parents: [], gitlinks: { contents: "stale" } });

    await push();

    expect(gh.refUpdates.at(-1)?.before).toBe(leftover);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("PR 作成が失敗し PR も存在しなければ、失敗を投げて再実行に委ねる", async () => {
    const { gh, push } = setup();
    gh.failures.createPullRequest = new DispatchError("retryable", "down");

    await expect(push()).rejects.toMatchObject({ kind: "retryable" });
  });
});

describe("順序の逆転と branch の再利用", () => {
  it("古い event が後から届いても、現在の HEAD に収束し commit も PR も増やさない", async () => {
    const { gh, push, sourceHead } = setup();
    const newer = gh.commit("o/src", "main");
    await push("o/src", "main", sourceHead);
    const commitCount = gh.commits.size;

    // 先に起きた push の event が後から届く
    await push("o/src", "main");

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(newer);
    expect(gh.commits.size).toBe(commitCount);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("branch が正しい状態で PR だけがなければ、新しい commit を作らず PR を作成する", async () => {
    const { gh, push } = setup();
    await push();
    const sha = gh.head("o/parent", BRANCH).sha;
    gh.pulls.forEach((pull) => (pull.state = "closed"));
    const commitCount = gh.commits.size;

    await push();

    expect(gh.head("o/parent", BRANCH).sha).toBe(sha);
    expect(gh.commits.size).toBe(commitCount);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });
});

describe("repository の rename と管理 branch の曖昧さ", () => {
  const renamedSetup = () => {
    const world = setup({ targets: [{ repository: "o/old-name", path: "contents" }] });
    // rename 前の名前でも同じ repository を指す
    world.gh.repos.set("o/old-name", must(world.gh.repos.get("o/parent")));
    return world;
  };

  it("YAML が rename 前の名前のままなら、現在の名前を使うよう設定エラーにし、何も更新しない", async () => {
    const { gh, push, logs } = renamedSetup();

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ kind: "config", errorMessage: "use the current repository name: o/parent" })
    );
  });

  it("parent の push では、YAML が旧名のままでも PR を Close せず、設定にないものとして記録するだけにする", async () => {
    const { gh, push, logs } = renamedSetup();
    const number = gh.addPull("o/parent");

    await push("o/parent", "main");

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(logs).toContainEqual(expect.objectContaining({ event: "target_skipped" }));
  });

  it("parent の push では、source の設定にない parent の PR を Close しない（Close は source の push の差分だけ）", async () => {
    const { gh, push, logs } = setup({ targets: [{ repository: "o/ghost", path: "x" }] });
    const number = gh.addPull("o/parent");

    await push("o/parent", "main");

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(logs).toContainEqual(expect.objectContaining({ event: "target_skipped" }));
  });

  it("旧設定と新設定が別名で同じ repository を指していれば、削除された target として扱わない", async () => {
    const { gh, push, sourceHead } = renamedSetup();
    await push();
    gh.commit("o/src", "main", { config: { targets: [{ repository: "o/parent", path: "contents" }] } });

    await push("o/src", "main", sourceHead);

    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });
});

describe("autoclosed の PR の再利用", () => {
  // 前回の同期で作られ、Dispatch が Close した PR
  const autoclosed = (gh: FakeGitHub, parentBase: string, state: FakePull["state"] = "closed", title = TITLE) => {
    const head = gh.commit("o/parent", BRANCH, {
      parents: [parentBase],
      gitlinks: { contents: "older-sha", other: "keep-sha" },
      message: TITLE,
    });
    const number = gh.addPull("o/parent", {
      state,
      title: state === "closed" && title === TITLE ? `${TITLE} - autoclosed` : title,
      headSha: head,
      closedOrder: 0,
    });
    return { head, number };
  };

  it("最後の PR が autoclosed なら、新しい PR を作らずに Open へ戻し、title を戻して更新する", async () => {
    const { gh, push, parentBase, sourceHead, logs } = setup();
    const { number } = autoclosed(gh, parentBase);

    await push();

    expect(gh.pulls).toHaveLength(1);
    expect(gh.pulls[0]).toMatchObject({ number, state: "open", title: TITLE });
    expect(gh.calls).not.toContain("createPullRequest");
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(sourceHead);
    expect(logs).toContainEqual(expect.objectContaining({ event: "pull_request_reopened", number }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "target_synced", outcome: "updated" }));
  });

  it("Close 中に head が動いていたら、Close したときの commit へ戻してから Open に戻す", async () => {
    const { gh, push, parentBase, sourceHead } = setup();
    const { head, number } = autoclosed(gh, parentBase);
    const moved = gh.commit("o/parent", BRANCH, { gitlinks: { contents: "manual" } });

    await push();

    expect(gh.refUpdates[0]).toEqual({ branch: BRANCH, before: moved, after: head });
    expect(gh.pulls[0]).toMatchObject({ number, state: "open" });
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(sourceHead);
  });

  it("管理 branch が消えていたら、Close したときの commit で作り直してから Open に戻す", async () => {
    const { gh, push, parentBase } = setup();
    const { head, number } = autoclosed(gh, parentBase);
    gh.repos.get("o/parent")?.branches.delete(BRANCH);

    await push();

    expect(gh.refUpdates[0]).toEqual({ branch: BRANCH, before: undefined, after: head });
    expect(gh.pulls[0]).toMatchObject({ number, state: "open" });
  });

  it.each([
    ["merge 済み", "merged" as const, TITLE],
    ["手動で Close された（suffix がない）", "closed" as const, "closed by hand"],
  ])("最後の PR が%sなら、新しい PR を作る", async (_name, state, title) => {
    const { gh, push, parentBase } = setup();
    const { number } = autoclosed(gh, parentBase, state, title);

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe(state);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(gh.calls).not.toContain("reopenPullRequest");
  });

  it("Close した順で最後の PR を選ぶ（後に作られた重複 PR が先に Close されていても、正規の PR を Open に戻す）", async () => {
    const { gh, push, parentBase } = setup();
    const { number } = autoclosed(gh, parentBase);
    const duplicate = gh.addPull("o/parent", { state: "closed", title: `dup - autoclosed`, closedOrder: -1 });
    must(gh.pulls.find((pull) => pull.number === duplicate)).headSha = gh.head("o/parent", BRANCH).sha;

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(gh.pulls.find((pull) => pull.number === duplicate)?.state).toBe("closed");
  });

  it("最後に Close された PR が merge 済みなら、それより前の autoclosed の PR は Open に戻さない", async () => {
    const { gh, push, parentBase } = setup();
    const { number } = autoclosed(gh, parentBase);
    gh.addPull("o/parent", { state: "merged", closedOrder: 1, headSha: gh.head("o/parent", BRANCH).sha });

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("closed");
    expect(gh.calls).not.toContain("reopenPullRequest");
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("head を戻した後に Open に戻すことを拒否されたら、戻した branch を読み直してから新しい PR を作る", async () => {
    const { gh, push, parentBase, sourceHead } = setup();
    const { head, number } = autoclosed(gh, parentBase);
    gh.commit("o/parent", BRANCH, { gitlinks: { contents: "manual" } });
    gh.rejectReopen = true;

    await push();

    expect(gh.refUpdates[0]?.after).toBe(head);
    // 読み直した後にも Open に戻すことを試み、拒否されてから新しい PR を作る
    expect(gh.calls.filter((call) => call === "reopenPullRequest")).toHaveLength(2);
    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("closed");
    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(sourceHead);
  });

  it("head を戻すときに競合したら、状態を取り直してからやり直す", async () => {
    const { gh, push, parentBase } = setup();
    const { number } = autoclosed(gh, parentBase);
    gh.commit("o/parent", BRANCH, { gitlinks: { contents: "manual" } });
    gh.remainingConflicts = 1;

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(gh.calls.filter((call) => call === "readParentState").length).toBeGreaterThan(1);
  });

  it("Open に戻した PR の base が違えば、既存の PR として base を直す", async () => {
    const { gh, push, parentBase, logs } = setup();
    const { number } = autoclosed(gh, parentBase);
    must(gh.pulls.find((pull) => pull.number === number)).baseBranch = "develop";

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)).toMatchObject({ state: "open", baseBranch: "main" });
    expect(logs).toContainEqual(expect.objectContaining({ event: "target_synced", outcome: "updated" }));
  });

  it("GitHub が Open に戻すことを拒否したら、新しい PR を作る", async () => {
    const { gh, push, parentBase, logs } = setup();
    const { number } = autoclosed(gh, parentBase);
    gh.rejectReopen = true;

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("closed");
    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({ event: "reopen_failed", number }));
  });

  it("更新が不要なら、autoclosed の PR を Open に戻さない", async () => {
    const { gh, push, parentBase, sourceHead } = setup();
    autoclosed(gh, parentBase);
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });

    await push();

    expect(gh.calls).not.toContain("reopenPullRequest");
    expect(gh.openPulls("o/parent")).toHaveLength(0);
  });
});

describe("Open PR の整理", () => {
  it("parent がすでに source の最新 gitlink を指していたら、Open PR を suffix 付きで Close する", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
    const number = gh.addPull("o/parent");

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)).toMatchObject({
      state: "closed",
      title: `${TITLE} - autoclosed`,
    });
    expect(gh.refUpdates).toEqual([]);
  });

  it("Close 済みの suffix を重複して付けない", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead } });
    const number = gh.addPull("o/parent", { title: `${TITLE} - autoclosed` });

    await push();

    expect(gh.pulls.find((pull) => pull.number === number)?.title).toBe(`${TITLE} - autoclosed`);
  });

  it("複数の Open 管理 PR は意図した base の最古を 1 つ残し、他を Close する", async () => {
    const { gh, push } = setup();
    gh.commit("o/parent", "dev", { parents: [], gitlinks: { contents: "old-sha" } });
    const wrongBase = gh.addPull("o/parent", { baseBranch: "dev" });
    const oldest = gh.addPull("o/parent");
    const newest = gh.addPull("o/parent");

    await push();

    expect(gh.openPulls("o/parent").map((pull) => pull.number)).toEqual([oldest]);
    expect(gh.pulls.find((pull) => pull.number === wrongBase)?.title).toBe(`${TITLE} - autoclosed`);
    expect(gh.pulls.find((pull) => pull.number === newest)?.state).toBe("closed");
  });

  it("config から target が削除されたら、before の設定から該当 PR を Close する", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/parent", "main", { gitlinks: { contents: "old-sha" } });
    const number = gh.addPull("o/parent");
    const newConfig = gh.commit("o/src", "main", { config: { targets: [] } });
    expect(newConfig).not.toBe(sourceHead);

    await push("o/src", "main", sourceHead);

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("closed");
  });

  it("config ファイルを削除した push でも、before の設定にあった target の PR を Close する", async () => {
    const { gh, push, sourceHead } = setup();
    const number = gh.addPull("o/parent");
    gh.commit("o/src", "main", { config: undefined });

    await push("o/src", "main", sourceHead);

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("closed");
  });

  it("旧設定が不正で読めなくても、cleanup を諦めて最新設定を適用する", async () => {
    const { gh, push, logs } = setup();
    const invalidOld = gh.commit("o/src", "main", { config: { targets: [], extra: 1 } });
    gh.commit("o/src", "main", { config: { targets: [{ repository: "o/parent", path: "contents" }] } });

    await push("o/src", "main", invalidOld);

    expect(logs).toContainEqual(expect.objectContaining({ event: "cleanup_skipped" }));
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("最新の設定に target が残っていれば、古い設定を理由に Close しない", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/src", "main", { config: { targets: [{ repository: "O/Parent", path: "contents" }] } });

    await push("o/src", "main", sourceHead);

    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("before がなければ（branch を新しく作った push）cleanup を推測せず、最新設定だけを適用する", async () => {
    const { gh, push, logs } = setup();
    gh.commit("o/src", "main", { config: { targets: [] } });
    gh.addPull("o/parent");

    await push("o/src", "main");

    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({ event: "cleanup_skipped" }));
  });
});

describe("parent の push", () => {
  it("base が進んだら、最新 base を唯一の親とする単一 commit に置き換える", async () => {
    const { gh, push } = setup();
    await push();
    const [pull] = gh.openPulls("o/parent");
    const newBase = gh.commit("o/parent", "main", { gitlinks: { contents: "old-sha", other: "changed", added: "a" } });

    await push("o/parent", "main");

    const { commit } = gh.head("o/parent", BRANCH);
    expect(commit.parents).toEqual([newBase]);
    expect(gh.trees.get(commit.tree)).toMatchObject({ other: "changed", added: "a" });
    expect(gh.openPulls("o/parent").map((candidate) => candidate.number)).toEqual([pull?.number]);
  });

  it("Open PR がなければ parent の push だけでは PR を作らない", async () => {
    const { gh, push } = setup();

    await push("o/parent", "main");

    expect(gh.pulls).toEqual([]);
    expect(gh.refUpdates).toEqual([]);
    // event の repository の Open PR は、source の状態と同じ問い合わせで取る
    expect(gh.calls).toEqual(["readRepositoryState"]);
  });

  it("push された branch を base としない管理 PR は同期しない", async () => {
    const { gh, push } = setup();
    await push();
    gh.commit("o/parent", "other-branch");
    const before = gh.refUpdates.length;

    await push("o/parent", "other-branch");

    expect(gh.refUpdates).toHaveLength(before);
  });

  it("source の設定から parent が消えていても、parent の push では Close しない", async () => {
    const { gh, push, logs } = setup();
    await push();
    gh.commit("o/src", "main", { config: { targets: [] } });
    gh.commit("o/parent", "main");

    await push("o/parent", "main");

    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({ event: "target_skipped" }));
  });

  it("管理 branch 名から source を戻せなければ、PR に触れず記録する", async () => {
    const { gh, push, logs, enqueued } = setup();
    await push();
    const number = gh.addPull("o/parent", { headBranch: "flightdeck-dispatch/not-a-source" });
    enqueued.length = 0;

    await push("o/parent", "main");

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(enqueued).toEqual([{ event: "sync-target", source: "o/src", target: "o/parent" }]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "head_skipped" }));
  });

  it("同期の途中で base が進んだら、最新の base から作り直す", async () => {
    const { gh, push } = setup();
    let advanced = false;
    gh.afterRefUpdate = () => {
      if (advanced) return;
      advanced = true;
      gh.commit("o/parent", "main", { gitlinks: { contents: "old-sha", other: "newer" } });
    };

    await push();

    const latestBase = gh.repos.get("o/parent")?.branches.get("main");
    expect(gh.head("o/parent", BRANCH).commit.parents).toEqual([latestBase]);
  });

  it("source と parent の両方の役割を持つ repo でも、必要な処理を 1 回ずつ実行する", async () => {
    const { gh, push } = setup({ targets: [{ repository: "o/parent", path: "contents" }] });
    // o/src 自身が別 repo の parent でもある構成
    gh.addRepo("o/leaf", "main");
    const leafHead = gh.commit("o/leaf", "main", {
      config: { targets: [{ repository: "o/src", path: "vendor/leaf" }] },
    });
    gh.commit("o/src", "main", {
      gitlinks: { "vendor/leaf": "old-leaf" },
      gitmodules: gitmodules("vendor/leaf", "o/leaf"),
    });
    gh.addPull("o/src", {
      headBranch: "flightdeck-dispatch/o/leaf",
      title: "chore(submodule): update o/leaf",
    });

    await push("o/src", "main");

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(gh.repos.get("o/src")?.branches.get("main"));
    expect(gh.gitlinks("o/src", "flightdeck-dispatch/o/leaf")?.["vendor/leaf"]).toBe(leafHead);
    expect(gh.refUpdates).toHaveLength(2);
    expect(gh.openPulls("o/src")).toHaveLength(1);
  });
});

describe("default branch の変更", () => {
  const parentWithDevelop = (config?: unknown) => {
    const world = setup(config);
    world.gh.commit("o/parent", "develop", {
      parents: [],
      gitlinks: { contents: "old-sha" },
      gitmodules: gitmodules("contents"),
    });
    return world;
  };

  it("base-branch を省略した target は、parent の新しい default branch へ PR の base を移して再生成する", async () => {
    const { gh, changeDefault, push } = parentWithDevelop();
    await push();
    const [pull] = gh.openPulls("o/parent");
    const developHead = gh.repos.get("o/parent")?.branches.get("develop");
    must(gh.repos.get("o/parent")).info.defaultBranch = "develop";

    await changeDefault("o/parent", "main");

    expect(gh.openPulls("o/parent")).toMatchObject([{ number: pull?.number, baseBranch: "develop" }]);
    expect(gh.head("o/parent", BRANCH).commit.parents).toEqual([developHead]);
  });

  it("base-branch を指定した target は新しい default branch へ移行しない", async () => {
    const { gh, changeDefault, push } = parentWithDevelop({
      targets: [{ repository: "o/parent", path: "contents", "base-branch": "main" }],
    });
    await push();
    must(gh.repos.get("o/parent")).info.defaultBranch = "develop";

    await changeDefault("o/parent", "main");

    expect(gh.openPulls("o/parent")).toMatchObject([{ baseBranch: "main" }]);
  });

  it("旧 default branch の設定と比べる", async () => {
    const { gh, changeDefault } = setup();

    await changeDefault("o/src", "main");

    expect(gh.previousRequests[0]).toEqual({ branch: "main" });
  });

  it("source の default branch が変わったら、新しい default HEAD と設定を使う", async () => {
    const { gh, changeDefault } = setup();
    const trunk = gh.commit("o/src", "trunk", {
      parents: [],
      config: { targets: [{ repository: "o/parent", path: "contents" }] },
    });
    must(gh.repos.get("o/src")).info.defaultBranch = "trunk";

    await changeDefault("o/src", "main");

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(trunk);
  });
});

describe("検証と失敗の扱い", () => {
  it("明示した base-branch が存在しなければ設定エラーとし、default branch へ fallback しない", async () => {
    const { gh, push, logs } = setup({
      targets: [{ repository: "o/parent", path: "contents", "base-branch": "missing" }],
    });

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "sync_failed", kind: "config" }));
  });

  it("path が gitlink でなければ更新しない", async () => {
    const { gh, push, logs } = setup({ targets: [{ repository: "o/parent", path: "other/dir" }] });

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "config" }));
  });

  it(".gitmodules の URL が source と一致しなければ更新しない", async () => {
    const { gh, push, logs } = setup();
    gh.commit("o/parent", "main", { gitmodules: gitmodules("contents", "o/another") });

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "config" }));
  });

  it("設定が不正な場合は他の処理をせず、再実行も要求しない", async () => {
    const { gh, push, logs } = setup({ targets: [{ repository: "o/parent", path: "../escape" }] });

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "config" }));
  });

  it("CAS に競合したら最新状態から取り直して再試行する", async () => {
    const { gh, push } = setup();
    gh.remainingConflicts = 1;

    await push();

    expect(gh.refUpdates).toHaveLength(1);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });

  it("競合が続く場合は上限で諦め、再実行を要求する", async () => {
    const { gh, push } = setup();
    gh.remainingConflicts = 100;

    await expect(push()).rejects.toMatchObject({ kind: "retryable" });
    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
  });

  it("権限エラーでは ref を更新せず、分類してログに残し再実行を要求しない", async () => {
    const { gh, push, logs } = setup();
    gh.failures.updateRef = new DispatchError("permission", "rejected by ruleset");

    await expect(push()).resolves.toBeUndefined();

    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "sync_failed", kind: "permission" }));
  });

  it("target ごとの message は独立していて、一方が待ち時間つきで失敗しても、他方は同期される", async () => {
    const { gh, push, sourceHead } = setup({
      targets: [
        { repository: "o/parent", path: "contents" },
        { repository: "o/second", path: "lib" },
      ],
    });
    gh.addRepo("o/second", "main");
    gh.commit("o/second", "main", { gitlinks: { lib: "old" }, gitmodules: gitmodules("lib") });
    gh.failures.createCommit = new DispatchError("retryable", "rate limited", { retryAfterSeconds: 30 });
    gh.failOnce.add("createCommit");

    await expect(push()).rejects.toMatchObject({ kind: "retryable", retryAfterSeconds: 30 });

    expect(gh.gitlinks("o/second", BRANCH)?.lib).toBe(sourceHead);
  });

  it("source を rename した後に .gitmodules が旧名の URL のままなら、設定エラーとして更新しない", async () => {
    const { gh, push, logs } = setup();
    gh.repos.set("o/old-src", must(gh.repos.get("o/src")));
    gh.commit("o/parent", "main", { gitmodules: gitmodules("contents", "o/old-src") });

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "config" }));
  });

  it("source を rename した後は、新しい名前の管理 branch で同期する（旧名の branch の PR はそのまま残る）", async () => {
    const { gh, push, sourceHead } = setup();
    gh.repos.set("o/oldsrc", must(gh.repos.get("o/src")));
    const number = gh.addPull("o/parent", { headBranch: "flightdeck-dispatch/o/oldsrc" });

    await push("o/parent", "main");

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(sourceHead);
  });

  it("設定の別の target を解決できなくても、削除された target の PR は Close する", async () => {
    const { gh, push, logs, sourceHead } = setup();
    const number = gh.addPull("o/parent");
    gh.commit("o/src", "main", { config: { targets: [{ repository: "o/ghost", path: "x" }] } });

    await push("o/src", "main", sourceHead);

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("closed");
    expect(logs).toContainEqual(expect.objectContaining({ kind: "permission" }));
  });

  it("source の名前が git の ref として使えない形なら、書き込みの前に設定エラーにする", async () => {
    const { gh, push, logs } = setup({ targets: [{ repository: "o/parent", path: "contents" }] });
    gh.addRepo("o/.github", "main");
    gh.commit("o/.github", "main", { config: { targets: [{ repository: "o/parent", path: "contents" }] } });
    gh.commit("o/parent", "main", { gitmodules: gitmodules("contents", "o/.github") });

    await push("o/.github", "main");

    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "sync_failed", kind: "config" }));
  });

  it("PR の作成が 422 などで失敗したら、再実行できる失敗として投げ、再実行で状態を読み直す", async () => {
    const { gh, push } = setup();
    gh.failures.createPullRequest = new DispatchError("retryable", "422");
    gh.failOnce.add("createPullRequest");

    await expect(push()).rejects.toMatchObject({ kind: "retryable" });
    expect(gh.openPulls("o/parent")).toEqual([]);

    await push();
    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(gh.calls.filter((call) => call === "createPullRequest")).toHaveLength(2);
  });

  it("PR の base だけを変更した場合も outcome は updated とする", async () => {
    const { gh, push, logs } = setup();
    await push();
    gh.commit("o/parent", "develop", {
      parents: [],
      gitlinks: { contents: "old-sha", other: "keep-sha" },
      gitmodules: gitmodules("contents"),
    });
    const pull = must(gh.openPulls("o/parent")[0]);
    pull.baseBranch = "develop";

    await push();

    expect(logs.filter((log) => log.event === "target_synced").at(-1)).toMatchObject({ outcome: "updated" });
  });

  it("前回の設定が見つからなければ cleanup_skipped を記録して続行する", async () => {
    const { gh, push, logs } = setup();

    await push("o/src", "main", "f".repeat(40));

    expect(logs).toContainEqual(expect.objectContaining({ event: "cleanup_skipped" }));
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });
});

describe("Close と更新の直前確認", () => {
  it("削除された target が、読み取りの後に設定へ戻されたら、PR を Close しない", async () => {
    const { gh, push, logs, sourceHead } = setup({ targets: [] });
    const number = gh.addPull("o/parent");
    // 最初の読み取りでは target が消えており、その直後に設定へ戻される
    const withParent = { targets: [{ repository: "o/parent", path: "contents" }] };
    const before = gh.commit("o/src", "main", { config: withParent });
    gh.commit("o/src", "main", { config: { targets: [] } });
    gh.afterRepositoryState = () => {
      gh.afterRepositoryState = undefined;
      gh.commit("o/src", "main", { config: withParent });
    };

    await push("o/src", "main", before);

    expect(sourceHead).toBeTruthy();
    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(logs).toContainEqual(expect.objectContaining({ event: "close_skipped" }));
  });

  it("P == S で PR を Close する直前に parent の base が進んでいたら、Close せず取り直す", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
    const number = gh.addPull("o/parent");
    gh.afterParentState = () => {
      gh.afterParentState = undefined;
      gh.commit("o/parent", "main", { gitlinks: { contents: "reverted", other: "keep-sha" } });
    };

    await push("o/src", "main", sourceHead);

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(sourceHead);
  });

  it("default branch が途中で変わったら、古い branch の HEAD で巻き戻さず、新しい default branch で更新する", async () => {
    const { gh, push } = setup();
    let trunk = "";
    gh.afterParentState = () => {
      gh.afterParentState = undefined;
      trunk = gh.commit("o/src", "trunk", {
        parents: [],
        config: { targets: [{ repository: "o/parent", path: "contents" }] },
      });
      must(gh.repos.get("o/src")).info.defaultBranch = "trunk";
    };

    await push();

    expect(trunk).not.toBe("");
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(trunk);
    expect(gh.refUpdates).toHaveLength(1);
  });
});

describe("source の HEAD の直前確認", () => {
  it("読み取りの後に source が進んでいたら、古い S で上書きせず取り直して新しい S で更新する", async () => {
    const { gh, push } = setup();
    let newest = "";
    gh.afterParentState = () => {
      gh.afterParentState = undefined;
      newest = gh.commit("o/src", "main");
    };

    await push();

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(newest);
    expect(gh.refUpdates).toHaveLength(1);
  });

  it("古い S で P == S と判断しても、source が進んでいたら PR を Close せず取り直す", async () => {
    const { gh, push, sourceHead } = setup();
    gh.commit("o/parent", "main", { gitlinks: { contents: sourceHead, other: "keep-sha" } });
    const number = gh.addPull("o/parent");
    let newest = "";
    gh.afterParentState = () => {
      gh.afterParentState = undefined;
      newest = gh.commit("o/src", "main");
    };

    await push("o/src", "main", sourceHead);

    expect(gh.pulls.find((pull) => pull.number === number)?.state).toBe("open");
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(newest);
  });
});

describe("取り直しと設定の検査", () => {
  it("source の設定が不正でも、default branch 以外の push では parent としての処理を止めない", async () => {
    const { gh, push, logs } = setup();
    gh.commit("o/src", "topic");
    gh.commit("o/src", "main", { config: new DispatchError("config", "invalid") });

    await push("o/src", "topic");

    expect(logs.filter((log) => log.event === "sync_failed")).toEqual([]);
  });

  it("parent の push では、別名の target は無視して、正規名の target で同期する", async () => {
    const { gh, push, logs } = setup();
    await push();
    gh.repos.set("o/old-name", must(gh.repos.get("o/parent")));
    gh.commit("o/src", "main", {
      config: {
        targets: [
          { repository: "o/old-name", path: "contents" },
          { repository: "o/parent", path: "contents" },
        ],
      },
    });
    gh.commit("o/parent", "main");

    await push("o/parent", "main");

    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(logs.filter((log) => log.event === "sync_failed")).toEqual([]);
  });

  it("CAS の競合で取り直すときは、その間に進んだ source の HEAD で更新する（古い SHA に戻さない）", async () => {
    const { gh, push } = setup();
    let newest = "";
    gh.remainingConflicts = 1;
    gh.beforeRefUpdate = () => {
      gh.beforeRefUpdate = undefined;
      newest = gh.commit("o/src", "main");
    };

    await push();

    expect(newest).not.toBe("");
    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(newest);
  });

  it("取り直すときに設定から target が消えていたら、更新せずに止める", async () => {
    const { gh, push, logs } = setup();
    gh.remainingConflicts = 1;
    gh.beforeRefUpdate = () => {
      gh.beforeRefUpdate = undefined;
      gh.commit("o/src", "main", { config: { targets: [] } });
    };

    await push();

    expect(gh.refUpdates).toEqual([]);
    expect(gh.pulls).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "target_skipped" }));
  });

  it("parent の push からの同期でも、取り直すときは進んだ source の HEAD を使う", async () => {
    const { gh, push } = setup();
    await push();
    gh.commit("o/parent", "main", { gitlinks: { contents: "old-sha", other: "changed" } });
    let newest = "";
    gh.remainingConflicts = 1;
    gh.beforeRefUpdate = () => {
      gh.beforeRefUpdate = undefined;
      newest = gh.commit("o/src", "main");
    };

    await push("o/parent", "main");

    expect(gh.gitlinks("o/parent", BRANCH)?.contents).toBe(newest);
  });

  it("別名で同じ repository を指す target が 2 つあっても、別名は設定エラーになり、同じ parent を 2 回更新しない", async () => {
    const { gh, push, logs } = setup({
      targets: [
        { repository: "o/old-name", path: "contents" },
        { repository: "o/parent", path: "contents" },
      ],
    });
    gh.repos.set("o/old-name", must(gh.repos.get("o/parent")));

    await push();

    expect(gh.refUpdates).toHaveLength(1);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({ event: "sync_failed", kind: "config" }));
  });

  it("前回の commit に設定ファイルがなかっただけなら、cleanup_skipped を記録しない", async () => {
    const { gh, push, logs } = setup();
    const noConfig = gh.commit("o/src", "main", { config: undefined });
    gh.commit("o/src", "main", { config: { targets: [{ repository: "o/parent", path: "contents" }] } });

    await push("o/src", "main", noConfig);

    expect(logs.filter((log) => log.event === "cleanup_skipped")).toEqual([]);
    expect(gh.openPulls("o/parent")).toHaveLength(1);
  });
});
