import { CONFIG_PATHS, MANAGED_BRANCH_PREFIX } from "@flightdeck/rules";
import { commitSha, githubId, repositoryFullName } from "@flightdeck/validation";
import * as v from "valibot";

import { parseResponse } from "./request.js";
import { isManagedBranch } from "../../domain/naming.js";
import { DispatchError } from "../../errors.js";

import type { Submodule } from "../../domain/gitmodules.js";
import type { OpenPullRequest, ParentState, RepositoryState } from "../../usecase/sync/dependencies.js";
import type { ConfigFile } from "@flightdeck/rules";

// 設定ファイルは本文をそのまま返す
const BLOB = "... on Blob { text isTruncated }";

// 両方の設定ファイルを同じ問い合わせで読み、どちらを使うかは use case が決める
const CONFIG_FILES = `
  yml: file(path: "${CONFIG_PATHS.yml}") { object { ${BLOB} } }
  yaml: file(path: "${CONFIG_PATHS.yaml}") { object { ${BLOB} } }`;

const SUBMODULES = "submodules(first: 100) { nodes { path gitUrl subprojectCommitOid } pageInfo { hasNextPage } }";

// head がその ref である Open PR を返す
// 別の repository の PR（fork の管理 branch から upstream へ出された PR など）も含まれるため、PR 自身の repository の id で絞る
const PULL_REQUEST_NODE = "number title baseRefName repository { id }";

// 本文は parent の PR を同期するときにだけ使う（source の管理 branch の一覧では読まない）
const OPEN_PULL_REQUESTS = `associatedPullRequests(states: OPEN, first: 10) { pageInfo { hasNextPage } nodes { ${PULL_REQUEST_NODE} body } }`;

// managed は refPrefix に管理 branch の prefix を含めず、query で絞る
// refPrefix に含めると、ref の name が prefix を除いた形で返り、Open PR があっても associatedPullRequests が空になる
export const REPOSITORY_QUERY = `query ReadRepository($owner: String!, $name: String!, $previous: String!, $hasPrevious: Boolean!, $withManaged: Boolean!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    isPrivate
    defaultBranchRef {
      name
      target { ... on Commit { oid ${CONFIG_FILES} } }
    }
    previous: object(expression: $previous) @include(if: $hasPrevious) {
      ... on Commit { oid ${CONFIG_FILES} }
    }
    managed: refs(refPrefix: "refs/heads/", query: "${MANAGED_BRANCH_PREFIX}", first: 100) @include(if: $withManaged) {
      pageInfo { hasNextPage }
      nodes { name associatedPullRequests(states: OPEN, first: 10) { pageInfo { hasNextPage } nodes { ${PULL_REQUEST_NODE} } } }
    }
  }
}`;

// 書き込みの直前に、source の default branch の名前と HEAD、parent の base の HEAD が動いていないか確かめる（それぞれの token で別々に問い合わせる）
export const SOURCE_HEAD_QUERY = `query CheckSource($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name target { oid } } }
}`;

export const PARENT_HEAD_QUERY = `query CheckParent($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid } } }
}`;

// latest は Close 済みと merge 済みを含めた、管理 branch を head とする PR を作成の新しい順に読む
// GitHub は Close の日時で並べ替えられないため、最後に Close された PR は読んだ中から選ぶ
// branch が消えていても見つかるよう、ref ではなく head の branch 名で探す
// fork の同名 branch から開かれた PR も含まれるため、head の repository の id で絞る
export const PARENT_QUERY = `query ReadParent($owner: String!, $name: String!, $headRef: String!, $headName: String!, $baseRef: String!, $hasBase: Boolean!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    isPrivate
    defaultBranchRef { name target @skip(if: $hasBase) { ...BaseCommit } }
    base: ref(qualifiedName: $baseRef) @include(if: $hasBase) { target { ...BaseCommit } }
    branch: ref(qualifiedName: $headRef) {
      ${OPEN_PULL_REQUESTS}
      target {
        ... on Commit {
          oid
          message
          changedFilesIfAvailable
          ${SUBMODULES}
          parents(first: 2) { nodes { oid } }
        }
      }
    }
    latest: pullRequests(headRefName: $headName, first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number title state closedAt headRefOid headRepository { id } }
    }
  }
}
fragment BaseCommit on Commit {
  oid
  tree { oid }
  ${SUBMODULES}
}`;

export const REPOSITORY_ID_QUERY = `query ReadRepositoryId($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id }
}`;

export const MANAGED_PULL_REQUESTS_QUERY = `query ReadManagedPullRequests($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    ref(qualifiedName: $ref) { ${OPEN_PULL_REQUESTS} }
  }
}`;

export const PATH_OBJECTS_QUERY = `query ReadPathObjects($owner: String!, $name: String!, $previous: String!, $source: String!) {
  repository(owner: $owner, name: $name) {
    previous: object(expression: $previous) { oid }
    source: object(expression: $source) { oid }
  }
}`;

const blobSchema = v.nullish(v.object({ text: v.nullish(v.string()), isTruncated: v.optional(v.boolean()) }));

const fileSchema = v.nullish(v.object({ object: blobSchema }));

const sourceCommitSchema = v.nullish(v.object({ oid: v.optional(commitSha), yml: fileSchema, yaml: fileSchema }));

const pullRequestNodeSchema = v.object({
  number: githubId,
  title: v.string(),
  baseRefName: v.string(),
  repository: v.object({ id: v.string() }),
});

const pullRequestsSchema = <T extends v.GenericSchema>(node: T) =>
  v.object({ pageInfo: v.object({ hasNextPage: v.boolean() }), nodes: v.array(node) });

const openPullRequestsSchema = pullRequestsSchema(v.object({ ...pullRequestNodeSchema.entries, body: v.string() }));

const sourceSchema = v.object({
  repository: v.object({
    id: v.string(),
    nameWithOwner: repositoryFullName,
    isPrivate: v.boolean(),
    defaultBranchRef: v.nullable(v.object({ name: v.string(), target: sourceCommitSchema })),
    previous: sourceCommitSchema,
    managed: v.optional(
      v.object({
        pageInfo: v.object({ hasNextPage: v.boolean() }),
        nodes: v.array(
          v.object({ name: v.string(), associatedPullRequests: pullRequestsSchema(pullRequestNodeSchema) })
        ),
      })
    ),
  }),
});

const submodulesSchema = v.object({
  nodes: v.array(v.object({ path: v.string(), gitUrl: v.string(), subprojectCommitOid: v.nullable(commitSha) })),
  pageInfo: v.object({ hasNextPage: v.boolean() }),
});

const baseCommitSchema = v.object({ oid: commitSha, tree: v.object({ oid: commitSha }), submodules: submodulesSchema });

const parentSchema = v.object({
  repository: v.object({
    id: v.string(),
    nameWithOwner: repositoryFullName,
    isPrivate: v.boolean(),
    defaultBranchRef: v.nullable(v.object({ name: v.string(), target: v.nullish(baseCommitSchema) })),
    base: v.nullish(v.object({ target: v.nullable(baseCommitSchema) })),
    branch: v.nullable(
      v.object({
        associatedPullRequests: openPullRequestsSchema,
        target: v.nullable(
          v.object({
            oid: commitSha,
            message: v.string(),
            changedFilesIfAvailable: v.nullable(v.number()),
            submodules: submodulesSchema,
            parents: v.object({ nodes: v.array(v.object({ oid: commitSha })) }),
          })
        ),
      })
    ),
    latest: v.object({
      nodes: v.array(
        v.object({
          number: githubId,
          title: v.string(),
          state: v.picklist(["OPEN", "CLOSED", "MERGED"]),
          closedAt: v.nullable(v.string()),
          headRefOid: commitSha,
          headRepository: v.nullable(v.object({ id: v.string() })),
        })
      ),
    }),
  }),
});

const managedSchema = v.object({
  repository: v.object({
    id: v.string(),
    nameWithOwner: repositoryFullName,
    ref: v.nullable(v.object({ associatedPullRequests: openPullRequestsSchema })),
  }),
});

const pathObjectsSchema = v.object({
  repository: v.object({
    previous: v.nullable(v.object({ oid: commitSha })),
    source: v.nullable(v.object({ oid: commitSha })),
  }),
});

// GitHub が .gitmodules を解釈した結果
// 一覧が 1 ページに収まらなければ、一部だけで判断しない
const toSubmodules = (value: v.InferOutput<typeof submodulesSchema>, what: string): Submodule[] => {
  if (value.pageInfo.hasNextPage) throw new DispatchError("undeterminable", `too many submodules: ${what}`);

  return value.nodes.map((node) => ({
    path: node.path,
    url: node.gitUrl,
    commitSha: node.subprojectCommitOid ?? undefined,
  }));
};

// 問い合わせた repository 自身の PR だけを残す（別の repository の PR は番号が同じでも別の PR）
const ownNodes = <T extends { repository: { id: string } }>(nodes: T[], repositoryId: string): T[] =>
  nodes.filter((pr) => pr.repository.id === repositoryId);

// 1 本の管理 branch に紐づく Open PR
// 件数が上限を超えるなら、一部だけで判断しない
const toPullRequests = (
  value: v.InferOutput<typeof openPullRequestsSchema>,
  repositoryId: string,
  what: string
): OpenPullRequest[] => {
  if (value.pageInfo.hasNextPage) throw new DispatchError("undeterminable", `too many open pull requests: ${what}`);

  return ownNodes(value.nodes, repositoryId).map((pr) => ({
    number: pr.number,
    title: pr.title,
    baseBranch: pr.baseRefName,
    body: pr.body,
  }));
};

// Blob の本文を返す
// ファイルがない、または Blob でなければ undefined
// 切り詰められた本文は一部の target だけの設定に見えるため、バイナリと同じく null にして、読めないことを use case に伝える
const blobText = (blob: v.InferOutput<typeof blobSchema>): string | null | undefined =>
  blob?.text === undefined ? undefined : blob.isTruncated ? null : blob.text;

// 存在する設定ファイルの本文（.yml と .yaml）
// ファイルがなければ含めず、読めないファイル（切り詰められた、バイナリ）は null にする
const configsOf = (commit: v.InferOutput<typeof sourceCommitSchema>): ConfigFile[] =>
  [
    { path: CONFIG_PATHS.yml, text: blobText(commit?.yml?.object) },
    { path: CONFIG_PATHS.yaml, text: blobText(commit?.yaml?.object) },
  ].filter((file): file is ConfigFile => file.text !== undefined);

export const parseRepositoryState = (data: unknown): RepositoryState => {
  const { repository } = parseResponse(sourceSchema, data, "repository");
  const head = repository.defaultBranchRef?.target;

  const refs = repository.managed;
  // query の一致の仕方は名前の prefix に限らないため、prefix で始まる branch だけを残す
  const managedRefs = (refs?.nodes ?? []).filter((ref) => isManagedBranch(ref.name));
  // ref の数や 1 本の PR の数が上限を超えるなら、一部だけで判断しない
  const overflow =
    refs?.pageInfo.hasNextPage === true || managedRefs.some((ref) => ref.associatedPullRequests.pageInfo.hasNextPage);
  const managed: RepositoryState["managed"] = overflow
    ? "overflow"
    : managedRefs
        .map((ref) => ({ ref, own: ownNodes(ref.associatedPullRequests.nodes, repository.id) }))
        .filter(({ own }) => own.length > 0)
        .map(({ ref, own }) => ({ head: ref.name, baseBranches: own.map((pr) => pr.baseRefName) }));

  return {
    repository: {
      fullName: repository.nameWithOwner,
      defaultBranch: repository.defaultBranchRef?.name ?? "",
      isPrivate: repository.isPrivate,
    },
    sha: head?.oid,
    configs: configsOf(head),
    previous: repository.previous?.oid ? { configs: configsOf(repository.previous) } : undefined,
    managed,
  };
};

const sourceHeadSchema = v.object({
  repository: v.object({
    defaultBranchRef: v.nullable(v.object({ name: v.string(), target: v.nullable(v.object({ oid: commitSha })) })),
  }),
});

const parentHeadSchema = v.object({
  repository: v.object({
    ref: v.nullable(v.object({ target: v.nullable(v.object({ oid: commitSha })) })),
  }),
});

// source の default branch の名前と HEAD が、渡された状態のままか
export const isSourceUnchanged = (data: unknown, expected: { defaultBranch: string; sha: string }): boolean => {
  const ref = parseResponse(sourceHeadSchema, data, "source head").repository.defaultBranchRef;

  return ref?.name === expected.defaultBranch && ref.target?.oid === expected.sha;
};

// parent の base の HEAD が、渡された SHA のままか
export const isParentUnchanged = (data: unknown, sha: string): boolean =>
  parseResponse(parentHeadSchema, data, "parent head").repository.ref?.target?.oid === sha;

export const parseParentState = (data: unknown, requestedBase: string | undefined): ParentState => {
  const { repository } = parseResponse(parentSchema, data, "parent");
  const info = {
    fullName: repository.nameWithOwner,
    defaultBranch: repository.defaultBranchRef?.name ?? "",
    isPrivate: repository.isPrivate,
  };

  const baseCommit = requestedBase === undefined ? repository.defaultBranchRef?.target : repository.base?.target;
  const baseBranch = requestedBase ?? repository.defaultBranchRef?.name;
  const branch = repository.branch;
  const target = branch?.target;

  const own = repository.latest.nodes.filter((pr) => pr.headRepository?.id === repository.id);
  // Open の PR があれば（Open PR の一覧の反映が遅れていても）、Close 済みの PR は使わない
  // closedAt は ISO 8601 の UTC なので、文字列のまま比べられる
  const lastClosed = own.some((pr) => pr.state === "OPEN")
    ? undefined
    : own.reduce<(typeof own)[number] | undefined>(
        (last, pr) => (last === undefined || (pr.closedAt ?? "") > (last.closedAt ?? "") ? pr : last),
        undefined
      );

  return {
    repository: info,
    base:
      baseCommit && baseBranch
        ? {
            branch: baseBranch,
            sha: baseCommit.oid,
            treeSha: baseCommit.tree.oid,
            submodules: toSubmodules(baseCommit.submodules, info.fullName),
          }
        : undefined,
    branch: target
      ? {
          sha: target.oid,
          parentShas: target.parents.nodes.map((parent) => parent.oid),
          message: target.message,
          // 管理 branch の一覧が不完全なら一致とみなさず、base から再生成して手動変更を修復する
          submodules: target.submodules.pageInfo.hasNextPage ? [] : toSubmodules(target.submodules, info.fullName),
          changedFiles: target.changedFilesIfAvailable,
        }
      : undefined,
    pullRequests: branch ? toPullRequests(branch.associatedPullRequests, repository.id, info.fullName) : [],
    lastClosedPullRequest: lastClosed
      ? {
          number: lastClosed.number,
          title: lastClosed.title,
          merged: lastClosed.state === "MERGED",
          headSha: lastClosed.headRefOid,
        }
      : undefined,
  };
};

const repositoryIdSchema = v.object({ repository: v.object({ id: v.string() }) });

export const parseRepositoryId = (data: unknown): string =>
  parseResponse(repositoryIdSchema, data, "repository id").repository.id;

export const parseManagedPullRequests = (
  data: unknown,
  repository: string
): { fullName: string; pullRequests: OpenPullRequest[] } => {
  const { id, nameWithOwner, ref } = parseResponse(managedSchema, data, "managed pull requests").repository;

  return {
    fullName: nameWithOwner,
    pullRequests: ref ? toPullRequests(ref.associatedPullRequests, id, repository) : [],
  };
};

export const parsePathObjects = (data: unknown): { previous: string | undefined; source: string | undefined } => {
  const { repository } = parseResponse(pathObjectsSchema, data, "path objects");

  return { previous: repository.previous?.oid, source: repository.source?.oid };
};
