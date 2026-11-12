import { splitRepository } from "@flightdeck/rules";
import { z } from "zod";

import { callGitHub, DEFAULT_RATE_LIMIT_DELAY_SECONDS, parseResponse, retryDelaySeconds } from "./request.js";
import {
  isParentUnchanged,
  isSourceUnchanged,
  MANAGED_PULL_REQUESTS_QUERY,
  PARENT_HEAD_QUERY,
  PARENT_QUERY,
  parseManagedPullRequests,
  parseParentState,
  parseRepositoryId,
  parseRepositoryState,
  REPOSITORY_ID_QUERY,
  REPOSITORY_QUERY,
  SOURCE_HEAD_QUERY,
} from "./state.js";
import { DispatchError } from "../../errors.js";

import type { Fetcher, GitHubCall } from "./request.js";
import type { IncludedCommits } from "../../domain/pull-request-body.js";
import type {
  DispatchGateway,
  OpenPullRequest,
  ParentState,
  RefUpdateResult,
  RepositoryState,
} from "../../usecase/sync/dependencies.js";

const ZERO_OID = "0000000000000000000000000000000000000000";
// compare の応答の上限
// Free plan の CPU 時間（Worker の 1 回の起動、つまり Queue の message 1 件の処理で 10 ms）のうち、JSON の解釈に使ってよい分の目安
const COMPARE_MAX_BYTES = 1024 * 1024;

const refSchema = z.object({ object: z.object({ sha: z.string() }) });
const shaSchema = z.object({ sha: z.string() });
const compareSchema = z.object({
  total_commits: z.number(),
  commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }) })),
});
const graphqlSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        type: z.string().optional(),
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      })
    )
    .optional(),
});
type GraphqlError = NonNullable<z.output<typeof graphqlSchema>["errors"]>[number];

const UPDATE_REFS = `mutation UpdateDispatchRef($repositoryId: ID!, $ref: GitRefname!, $before: GitObjectID!, $after: GitObjectID!) {
  updateRefs(input: { repositoryId: $repositoryId, refUpdates: [{ name: $ref, beforeOid: $before, afterOid: $after, force: true }] }) {
    clientMutationId
  }
}`;

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

// retryDelay は応答の header から求めた待ち時間（なければ既定値）
const classify = (error: GraphqlError, repository: string, retryDelay?: number): DispatchError => {
  if (error.type === "RATE_LIMITED") {
    return new DispatchError("retryable", "GitHub GraphQL rate limited", {
      retryAfterSeconds: retryDelay ?? DEFAULT_RATE_LIMIT_DELAY_SECONDS,
    });
  }

  if (error.type === "NOT_FOUND") {
    // 一部の repository だけに入れた Installation では、入っていない repository は NOT_FOUND になる
    return new DispatchError("permission", `the App may not have access to the repository: ${repository}`);
  }

  if (error.type === "FORBIDDEN") return new DispatchError("permission", `GitHub GraphQL denied: ${repository}`);

  // timeout など type のない失敗も HTTP 200 で返るため、retry に任せる（回数は Queue の max_retries が抑える）
  return new DispatchError("retryable", `GitHub GraphQL failed: ${repository}`);
};

export class GitHubGatewayImpl implements DispatchGateway {
  constructor(
    private readonly input: {
      fetcher: Fetcher;
      getToken: (repository: string) => Promise<string>;
    }
  ) {}

  async getBranchHead(repository: string, branch: string): Promise<string | undefined> {
    const ref = await this.call(repository, {
      method: "GET",
      path: `/repos/${repository}/git/ref/heads/${encodePath(branch)}`,
      optional: true,
    });

    return ref === undefined ? undefined : parseResponse(refSchema, ref, "ref").object.sha;
  }

  async readRepositoryState(
    repository: string,
    options?: { previous?: { sha: string } | { branch: string }; withManaged?: boolean }
  ): Promise<RepositoryState> {
    const previous = options?.previous;
    const data = await this.query(repository, REPOSITORY_QUERY, {
      previous: previous === undefined ? "" : "sha" in previous ? previous.sha : `refs/heads/${previous.branch}`,
      hasPrevious: previous !== undefined,
      withManaged: options?.withManaged === true,
    });

    return parseRepositoryState(data);
  }

  async readParentState(
    repository: string,
    { baseBranch, head, path }: { baseBranch: string | undefined; head: string; path: string }
  ): Promise<ParentState> {
    const data = await this.query(repository, PARENT_QUERY, {
      headRef: `refs/heads/${head}`,
      headName: head,
      baseRef: `refs/heads/${baseBranch ?? ""}`,
      hasBase: baseBranch !== undefined,
      path,
    });

    return parseParentState(data, baseBranch);
  }

  // source と parent は、それぞれの token で並行して確かめる
  async checkUnchanged({
    source,
    parent,
  }: {
    source: { repository: string; defaultBranch: string; sha: string };
    parent: { repository: string; branch: string; sha: string };
  }): Promise<boolean> {
    const [sourceData, parentData] = await Promise.all([
      this.query(source.repository, SOURCE_HEAD_QUERY, {}),
      this.query(parent.repository, PARENT_HEAD_QUERY, { ref: `refs/heads/${parent.branch}` }),
    ]);

    return (
      isSourceUnchanged(sourceData, { defaultBranch: source.defaultBranch, sha: source.sha }) &&
      isParentUnchanged(parentData, parent.sha)
    );
  }

  async readManagedPullRequests(
    repository: string,
    head: string
  ): Promise<{ fullName: string; pullRequests: OpenPullRequest[] }> {
    const data = await this.query(repository, MANAGED_PULL_REQUESTS_QUERY, { ref: `refs/heads/${head}` });

    return parseManagedPullRequests(data, repository);
  }

  async createPullRequest(
    repository: string,
    { head, base, title, body }: { head: string; base: string; title: string; body: string }
  ): Promise<void> {
    await this.call(repository, {
      method: "POST",
      path: `/repos/${repository}/pulls`,
      body: { head, base, title, body, draft: false },
    });
  }

  async updatePullRequest(
    repository: string,
    number: number,
    patch: { baseBranch?: string; title?: string; body?: string; closed?: boolean }
  ): Promise<void> {
    await this.call(repository, {
      method: "PATCH",
      path: `/repos/${repository}/pulls/${String(number)}`,
      body: {
        base: patch.baseBranch,
        title: patch.title,
        body: patch.body,
        state: patch.closed ? "closed" : undefined,
      },
    });
  }

  // Close 中に head が force push された PR は 422 で拒否される
  async reopenPullRequest(repository: string, number: number, title: string): Promise<boolean> {
    const reopened = await this.call(repository, {
      method: "PATCH",
      path: `/repos/${repository}/pulls/${String(number)}`,
      body: { state: "open", title },
      rejectable: true,
    });

    return reopened !== undefined;
  }

  // GitHub は新しい側の最大 250 件を、古い順に返す（total_commits は省いた分を含む総数）
  // Markdown は単独の CR も改行とみなすため、件名は CR でも区切る
  // base が repository にない、または head と共通の祖先がなければ 404 になる
  // 応答は変更されたファイルと patch も含むため、大きすぎれば解釈せずに一覧を諦める
  async compareCommits(repository: string, base: string, head: string): Promise<IncludedCommits | undefined> {
    const compared = await this.call(repository, {
      method: "GET",
      path: `/repos/${repository}/compare/${base}...${head}`,
      optional: true,
      maxBytes: COMPARE_MAX_BYTES,
    });
    if (compared === undefined) return undefined;

    const { total_commits, commits } = parseResponse(compareSchema, compared, "compare");

    return {
      commits: commits.map(({ sha, commit }) => ({ sha, subject: commit.message.split(/\r\n?|\n/)[0] ?? "" })),
      total: total_commits,
    };
  }

  async createGitlinkTree(
    repository: string,
    { baseTreeSha, path, gitlinkSha }: { baseTreeSha: string; path: string; gitlinkSha: string }
  ): Promise<string> {
    // base_tree を必ず指定し、対象の gitlink 以外を変更しない
    const tree = await this.call(repository, {
      method: "POST",
      path: `/repos/${repository}/git/trees`,
      body: { base_tree: baseTreeSha, tree: [{ path, mode: "160000", type: "commit", sha: gitlinkSha }] },
    });

    return parseResponse(shaSchema, tree, "tree").sha;
  }

  async createCommit(
    repository: string,
    { treeSha, parentSha, message }: { treeSha: string; parentSha: string; message: string }
  ): Promise<string> {
    const commit = await this.call(repository, {
      method: "POST",
      path: `/repos/${repository}/git/commits`,
      body: { message, tree: treeSha, parents: [parentSha] },
    });

    return parseResponse(shaSchema, commit, "commit").sha;
  }

  async updateRef(
    repository: string,
    branch: string,
    { before, after }: { before: string | undefined; after: string }
  ): Promise<RefUpdateResult> {
    // ref の更新（GraphQL の mutation）は repository の node ID で対象を指定する
    const repositoryId = parseRepositoryId(await this.query(repository, REPOSITORY_ID_QUERY, {}));

    try {
      await this.send(repository, UPDATE_REFS, {
        repositoryId,
        ref: `refs/heads/${branch}`,
        before: before ?? ZERO_OID,
        after,
      });

      return "updated";
    } catch (error) {
      // GraphQL のエラー文言は判別に使わず、branch の HEAD が before から動いていれば競合とみなす
      // 動いていなければ、分類済みのエラー（RATE_LIMITED は待ち時間つき、FORBIDDEN は権限エラー、その他は再試行可能）を返す
      if ((await this.getBranchHead(repository, branch)) !== before) return "conflict";

      throw error;
    }
  }

  private async call(repository: string, request: GitHubCall): Promise<unknown> {
    return callGitHub(this.input.fetcher, await this.input.getToken(repository), request);
  }

  // GraphQL
  // エラーは失敗として扱い、type で分類する
  // ただし、top-level の field の下（file、object など）の NOT_FOUND は、その field が指す file や ref がないことを表し、data のその箇所は null になる
  // この場合は失敗にしない（top-level の field 自体の NOT_FOUND は、repository が見えない失敗）
  // 問い合わせと mutation の top-level の field は 1 つ（repository、updateRefs）だけなので、アクセスできない失敗は path の長さ 1 で現れる
  private async send(repository: string, text: string, variables: Record<string, unknown>): Promise<unknown> {
    let retryDelay: number | undefined;
    const raw = await callGitHub(
      this.input.fetcher,
      await this.input.getToken(repository),
      { method: "POST", path: "/graphql", body: { query: text, variables } },
      (response) => {
        retryDelay = retryDelaySeconds(response);
      }
    );
    const response = parseResponse(graphqlSchema, raw, "graphql");

    const error = response.errors?.find(
      (candidate) => !(candidate.type === "NOT_FOUND" && (candidate.path?.length ?? 0) >= 2)
    );
    if (error) throw classify(error, repository, retryDelay);

    return response.data;
  }

  // repository の問い合わせは owner と name を変数に足す
  private query(repository: string, text: string, variables: Record<string, unknown>): Promise<unknown> {
    return this.send(repository, text, { ...splitRepository(repository), ...variables });
  }
}
