import { CONFIG_PATHS, MANAGED_BRANCH_PREFIX } from "@flightdeck/rules";
import { z } from "zod";

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
const SUBMODULES = "submodules(first: 100) { nodes { path gitUrl } pageInfo { hasNextPage } }";
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
export const PARENT_QUERY = `query ReadParent($owner: String!, $name: String!, $headRef: String!, $headName: String!, $baseRef: String!, $hasBase: Boolean!, $path: String!) {
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
          link: file(path: $path) { type oid }
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
  link: file(path: $path) { type oid }
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

const blobSchema = z
  .object({ text: z.string().nullable().optional(), isTruncated: z.boolean().optional() })
  .nullable()
  .optional();
const fileSchema = z.object({ object: blobSchema }).nullable().optional();

const sourceCommitSchema = z
  .object({ oid: z.string().optional(), yml: fileSchema, yaml: fileSchema })
  .nullable()
  .optional();
const pullRequestNodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  baseRefName: z.string(),
  repository: z.object({ id: z.string() }),
});
const pullRequestsSchema = <T extends z.ZodType>(node: T) =>
  z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(node) });
const openPullRequestsSchema = pullRequestsSchema(pullRequestNodeSchema.extend({ body: z.string() }));
const sourceSchema = z.object({
  repository: z.object({
    id: z.string(),
    nameWithOwner: z.string(),
    isPrivate: z.boolean(),
    defaultBranchRef: z.object({ name: z.string(), target: sourceCommitSchema }).nullable(),
    previous: sourceCommitSchema,
    managed: z
      .object({
        pageInfo: z.object({ hasNextPage: z.boolean() }),
        nodes: z.array(
          z.object({
            name: z.string(),
            associatedPullRequests: pullRequestsSchema(pullRequestNodeSchema),
          })
        ),
      })
      .optional(),
  }),
});
const submodulesSchema = z.object({
  nodes: z.array(z.object({ path: z.string(), gitUrl: z.string() })),
  pageInfo: z.object({ hasNextPage: z.boolean() }),
});
const baseCommitSchema = z.object({
  oid: z.string(),
  tree: z.object({ oid: z.string() }),
  link: z.object({ type: z.string(), oid: z.string() }).nullable().optional(),
  submodules: submodulesSchema,
});
const parentSchema = z.object({
  repository: z.object({
    id: z.string(),
    nameWithOwner: z.string(),
    isPrivate: z.boolean(),
    defaultBranchRef: z.object({ name: z.string(), target: baseCommitSchema.nullable().optional() }).nullable(),
    base: z.object({ target: baseCommitSchema.nullable() }).nullable().optional(),
    branch: z
      .object({
        associatedPullRequests: openPullRequestsSchema,
        target: z
          .object({
            oid: z.string(),
            message: z.string(),
            changedFilesIfAvailable: z.number().nullable(),
            link: z.object({ type: z.string(), oid: z.string() }).nullable().optional(),
            parents: z.object({ nodes: z.array(z.object({ oid: z.string() })) }),
          })
          .nullable(),
      })
      .nullable(),
    latest: z.object({
      nodes: z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          state: z.enum(["OPEN", "CLOSED", "MERGED"]),
          closedAt: z.string().nullable(),
          headRefOid: z.string(),
          headRepository: z.object({ id: z.string() }).nullable(),
        })
      ),
    }),
  }),
});
const managedSchema = z.object({
  repository: z.object({
    id: z.string(),
    nameWithOwner: z.string(),
    ref: z.object({ associatedPullRequests: openPullRequestsSchema }).nullable(),
  }),
});

// GitHub が .gitmodules を解釈した結果
// 一覧が 1 ページに収まらなければ、一部だけで判断しない
const toSubmodules = (value: z.output<typeof submodulesSchema>, what: string): Submodule[] => {
  if (value.pageInfo.hasNextPage) throw new DispatchError("undeterminable", `too many submodules: ${what}`);

  return value.nodes.map((node) => ({ path: node.path, url: node.gitUrl }));
};

// 問い合わせた repository 自身の PR だけを残す（別の repository の PR は番号が同じでも別の PR）
const ownNodes = <T extends { repository: { id: string } }>(nodes: T[], repositoryId: string): T[] =>
  nodes.filter((pr) => pr.repository.id === repositoryId);

// 1 本の管理 branch に紐づく Open PR
// 件数が上限を超えるなら、一部だけで判断しない
const toPullRequests = (
  value: z.output<typeof openPullRequestsSchema>,
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
const blobText = (blob: z.output<typeof blobSchema>): string | null | undefined =>
  blob?.text === undefined ? undefined : blob.isTruncated ? null : blob.text;

// 存在する設定ファイルの本文（.yml と .yaml）
// ファイルがなければ含めず、読めないファイル（切り詰められた、バイナリ）は null にする
const configsOf = (commit: z.output<typeof sourceCommitSchema>): ConfigFile[] =>
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

const sourceHeadSchema = z.object({
  repository: z.object({
    defaultBranchRef: z.object({ name: z.string(), target: z.object({ oid: z.string() }).nullable() }).nullable(),
  }),
});
const parentHeadSchema = z.object({
  repository: z.object({ ref: z.object({ target: z.object({ oid: z.string() }).nullable() }).nullable() }),
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
            // gitlink は tree entry の type が commit になる
            gitlinkSha: baseCommit.link?.type === "commit" ? baseCommit.link.oid : undefined,
            submodules: toSubmodules(baseCommit.submodules, info.fullName),
          }
        : undefined,
    branch: target
      ? {
          sha: target.oid,
          parentShas: target.parents.nodes.map((parent) => parent.oid),
          message: target.message,
          gitlinkSha: target.link?.type === "commit" ? target.link.oid : undefined,
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

const repositoryIdSchema = z.object({ repository: z.object({ id: z.string() }) });

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
