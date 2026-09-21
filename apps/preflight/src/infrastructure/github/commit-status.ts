import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";
import { truncateCommitStatusDescription } from "../../domain/commit-status-description.js";
import { GitHubError } from "../../errors.js";
import { isRecord } from "../../util/type-guards.js";

import type {
  ObservedTitleStatusState,
  PullRequestCommitTitleStatus,
  TitleStatusState,
} from "../../usecase/title-validation/dependencies.js";

export const PR_TITLE_STATUS_CONTEXT = "PR Title";

// 1 commit あたりの関連 PR をこの数まで確認する
// 超える commit は shared head の判定ができないため触らない
// Commit.associatedPullRequests は state で絞り込めないので、open だけを取り出す処理は client 側で行う
const MAX_ASSOCIATED_PULL_REQUESTS = 20;

const PULL_REQUEST_TITLE_STATUSES_QUERY = `
  query PullRequestTitleStatuses($owner: String!, $repo: String!, $number: Int!, $context: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(first: 100, after: $cursor) {
          nodes {
            commit {
              oid
              status {
                context(name: $context) {
                  state
                }
              }
              associatedPullRequests(first: ${String(MAX_ASSOCIATED_PULL_REQUESTS)}) {
                totalCount
                nodes {
                  state
                  headRefOid
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

export const setPullRequestTitleStatus = async (input: {
  owner: string;
  repo: string;
  sha: string;
  state: TitleStatusState;
  description: string;
  targetUrl?: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<void> => {
  // 長すぎる description は 422 になる
  // ここで落とすと delivery ごと retry されるため、切り詰めて verdict を届ける
  const description = truncateCommitStatusDescription(input.description);
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const sha = encodeURIComponent(input.sha);
  await githubRequest({
    url: `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/statuses/${sha}`,
    method: "POST",
    token: input.installationToken,
    body: {
      state: input.state,
      description,
      context: PR_TITLE_STATUS_CONTEXT,
      target_url: input.targetUrl,
    },
    expectedStatuses: [201],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,

    // GitHub は POST のたびに新しい status を追加し、同一 context では最新の 1 件だけを評価する
    // 同一 context は冪等キーではない
    // retry は応答喪失後に同一内容を再送し、attempt 間には再送待ちを挟む
    // その間に別 delivery が新しい verdict を投稿すると、この POST が保持する古い verdict が後からそれを上書きする逆転が理論上起こり得る
    // 再送待ちは既定で合計 2000ms までだが、budget は実行中の fetch を中断しない
    // そのため fetch 自体が長引いた分だけ、古い verdict が生き残りうる時間窓は 2000ms より長くなりうる

    // 逆転のうち PR の title や head SHA が変わった結果として起きるものは、
    // title-validation/impl.ts の stabilizeCurrentCheck が POST 直後に入力状態を読み直して検出し、
    // MAX_STATUS_STABILIZATION_ATTEMPTS 回まで再収束させる
    // stabilizeCurrentCheck を通らない bestEffortFailClosedStatuses などの fail-closed の直接投稿には、
    // 入力状態が変わらないまま古い verdict の retry に上書きされるリスクが残る
    // この上書きは次に同じ head SHA を収束させる delivery（再配信や後続イベント）が来れば是正されるが、その到来自体は保証されない
    // retry を無効にすると 5xx/429/network error のたびに fail-closed の verdict そのものが届かず終わるため、このリスクを承知で retry を有効にする
    retry: true,
  });
};

interface CommitTitleStatusPage {
  commits: PullRequestCommitTitleStatus[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const parseObservedTitleStatusState = (value: unknown): ObservedTitleStatusState | undefined => {
  switch (value) {
    case "SUCCESS":
      return "success";
    case "ERROR":
    case "EXPECTED":
    case "FAILURE":
    case "PENDING":
      return "not_success";
    default:
      return undefined;
  }
};

const parseCommit = (value: unknown): PullRequestCommitTitleStatus | null => {
  if (!isRecord(value) || !isRecord(value.commit)) return null;
  const commit = value.commit;
  if (typeof commit.oid !== "string" || commit.oid.length === 0) return null;

  if (!Object.hasOwn(commit, "status")) return null;
  let contextState: ObservedTitleStatusState | null = null;
  if (commit.status !== null) {
    if (!isRecord(commit.status)) return null;
    if (!Object.hasOwn(commit.status, "context")) return null;
    const context = commit.status.context;
    if (context !== null) {
      if (!isRecord(context)) return null;
      const parsedContextState = parseObservedTitleStatusState(context.state);
      if (parsedContextState === undefined) return null;
      contextState = parsedContextState;
    }
  }

  const associated = commit.associatedPullRequests;
  if (!isRecord(associated) || typeof associated.totalCount !== "number" || !Array.isArray(associated.nodes)) {
    return null;
  }
  const openHeads: string[] = [];
  for (const node of associated.nodes as unknown[]) {
    if (!isRecord(node) || typeof node.headRefOid !== "string" || typeof node.state !== "string") return null;
    if (node.state === "OPEN") openHeads.push(node.headRefOid);
  }

  return {
    sha: commit.oid,
    statusState: contextState,
    isOpenPullRequestHead: openHeads.includes(commit.oid),
    associatedPullRequestsTruncated: associated.totalCount > (associated.nodes as unknown[]).length,
  };
};

const parseCommitTitleStatusPage = (value: unknown): CommitTitleStatusPage | null => {
  // GraphQL は partial error でも HTTP 200 を返す
  // errors が付いた response は信用しない
  if (!isRecord(value) || value.errors !== undefined || !isRecord(value.data)) return null;
  const repository = value.data.repository;
  if (!isRecord(repository) || !isRecord(repository.pullRequest)) return null;
  const commits = repository.pullRequest.commits;
  if (!isRecord(commits) || !Array.isArray(commits.nodes) || !isRecord(commits.pageInfo)) return null;
  if (typeof commits.pageInfo.hasNextPage !== "boolean") return null;
  const endCursor = commits.pageInfo.endCursor;
  if (endCursor !== null && typeof endCursor !== "string") return null;

  const parsed = (commits.nodes as unknown[]).map(parseCommit);
  if (parsed.some((commit) => commit === null)) return null;
  return {
    commits: parsed as PullRequestCommitTitleStatus[],
    hasNextPage: commits.pageInfo.hasNextPage,
    endCursor,
  };
};

/** PR の全 commit について、`PR Title` status と open PR head かどうかを返す */
export const listPullRequestCommitTitleStatuses = async (input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<PullRequestCommitTitleStatus[]> => {
  const commits: PullRequestCommitTitleStatus[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    const response = await githubRequest({
      url: `${GITHUB_API_BASE_URL}/graphql`,
      method: "POST",
      token: input.installationToken,
      body: {
        query: PULL_REQUEST_TITLE_STATUSES_QUERY,
        variables: {
          owner: input.owner,
          repo: input.repo,
          number: input.pullRequestNumber,
          context: PR_TITLE_STATUS_CONTEXT,
          cursor,
        },
      },
      expectedStatuses: [200],
      errorCode: "GITHUB_API_FAILED",
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
    const page = parseCommitTitleStatusPage(await readGitHubJson(response, "GITHUB_API_FAILED", input.signal));
    if (!page) throw invalidShapeError(response, "GITHUB_API_FAILED", "commit status");
    commits.push(...page.commits);

    if (!page.hasNextPage) return commits;
    const nextCursor = page.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new GitHubError("GITHUB_API_FAILED", "Invalid GitHub GraphQL pagination cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
};
