import { isOutsideDefaultBranch, parseAssociatedPullRequests } from "./associated-pull-requests.js";
import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";
import { truncateCommitStatusDescription } from "../../domain/commit-status-description.js";
import { GitHubError } from "../../errors.js";
import { isRecord } from "../../util/type-guards.js";

import type {
  AssociatedPullRequestTitle,
  ObservedTitleStatusState,
  PullRequestCommitTitleStatus,
  TitleStatusState,
} from "../../usecase/title-validation/dependencies.js";
import type { Logger } from "../../util/logger.js";

export const PR_TITLE_STATUS_CONTEXT = "PR Title";

const PULL_REQUEST_TITLE_STATUSES_QUERY = `
  query PullRequestTitleStatuses($owner: String!, $repo: String!, $number: Int!, $context: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(first: 100, after: $cursor) {
          totalCount
          nodes {
            commit {
              oid
              status {
                context(name: $context) {
                  state
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
  retry?: boolean;
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
    retry: input.retry ?? true,
  });
};

interface CommitTitleStatusPage {
  commits: PullRequestCommitTitleStatus[];
  totalCount: number;
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

  return { sha: commit.oid, statusState: contextState };
};

const parseCommitTitleStatusPage = (value: unknown): CommitTitleStatusPage | null => {
  // GraphQL は partial error でも HTTP 200 を返す
  // errors が付いた response は信用しない
  if (!isRecord(value) || value.errors !== undefined || !isRecord(value.data)) return null;
  const repository = value.data.repository;
  if (!isRecord(repository) || !isRecord(repository.pullRequest)) return null;
  const commits = repository.pullRequest.commits;
  if (!isRecord(commits) || !Array.isArray(commits.nodes) || !isRecord(commits.pageInfo)) return null;
  if (typeof commits.pageInfo.hasNextPage !== "boolean" || typeof commits.totalCount !== "number") return null;
  const endCursor = commits.pageInfo.endCursor;
  if (endCursor !== null && typeof endCursor !== "string") return null;

  const parsed = (commits.nodes as unknown[]).map(parseCommit);
  if (parsed.some((commit) => commit === null)) return null;
  return {
    commits: parsed as PullRequestCommitTitleStatus[],
    totalCount: commits.totalCount,
    hasNextPage: commits.pageInfo.hasNextPage,
    endCursor,
  };
};

/** PR の commit について `PR Title` status を返す */
export const listPullRequestCommitTitleStatuses = async (input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  logger: Logger;
  deliveryId: string;
  maxPages: number;
}): Promise<PullRequestCommitTitleStatus[]> => {
  const commits: PullRequestCommitTitleStatus[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let expectedTotalCount: number | undefined;

  const logTotalCountMismatch = (expected: number): void => {
    if (expected !== commits.length) {
      input.logger.log("warn", {
        event: "github_webhook_consume",
        feature: "title-validation",
        result: "sweep_commit_total_count_mismatch",
        deliveryId: input.deliveryId,
        expectedTotalCount: expected,
        observedTotalCount: commits.length,
      });
    }
  };

  let pageCount = 0;
  for (;;) {
    if (pageCount >= input.maxPages) {
      if (expectedTotalCount !== undefined) logTotalCountMismatch(expectedTotalCount);
      input.logger.log("warn", {
        event: "github_webhook_consume",
        feature: "title-validation",
        result: "sweep_commit_budget_exhausted",
        deliveryId: input.deliveryId,
        observedTotalCount: commits.length,
      });
      return commits;
    }
    pageCount += 1;
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
    expectedTotalCount = page.totalCount;

    if (!page.hasNextPage) {
      logTotalCountMismatch(page.totalCount);
      return commits;
    }
    input.logger.log("info", {
      event: "github_webhook_consume",
      feature: "title-validation",
      result: "sweep_commits_has_next_page",
      deliveryId: input.deliveryId,
      observedTotalCount: commits.length,
    });
    const nextCursor = page.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      input.logger.log("warn", {
        event: "github_webhook_consume",
        feature: "title-validation",
        result: "sweep_commit_cursor_cycle",
        deliveryId: input.deliveryId,
      });
      throw new GitHubError("GITHUB_API_FAILED", "Invalid GitHub GraphQL pagination cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
};

/** 書き込んだ SHA の関連 PR と default branch をまとめて確認する */
export const confirmSweepCommits = async (input: {
  owner: string;
  repo: string;
  shas: string[];
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<Map<string, AssociatedPullRequestTitle[] | undefined>> => {
  if (input.shas.length === 0) return new Map();

  const variables: Record<string, string> = { owner: input.owner, repo: input.repo };
  const declarations: string[] = [];
  const objects: string[] = [];
  const comparisons: string[] = [];
  input.shas.forEach((sha, i) => {
    variables[`sha${String(i)}`] = sha;
    variables[`oid${String(i)}`] = sha;
    declarations.push(`$sha${String(i)}: String!, $oid${String(i)}: GitObjectID!`);
    objects.push(
      `o${String(i)}: object(oid: $oid${String(i)}) { ... on Commit { associatedPullRequests(first: 100) { totalCount nodes { number title state isDraft headRefOid } pageInfo { hasNextPage } } } }`
    );
    comparisons.push(`c${String(i)}: compare(headRef: $sha${String(i)}) { status headTarget { oid } }`);
  });
  const response = await githubRequest({
    url: `${GITHUB_API_BASE_URL}/graphql`,
    method: "POST",
    token: input.installationToken,
    body: {
      query: `query ConfirmSweep($owner: String!, $repo: String!, ${declarations.join(", ")}) { repository(owner: $owner, name: $repo) { ${objects.join(" ")} defaultBranchRef { ${comparisons.join(" ")} } } }`,
      variables,
    },
    expectedStatuses: [200],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const body: unknown = await readGitHubJson(response, "GITHUB_API_FAILED", input.signal);
  if (!isRecord(body) || body.errors !== undefined || !isRecord(body.data) || !isRecord(body.data.repository))
    throw invalidShapeError(response, "GITHUB_API_FAILED", "sweep confirmation");
  const repository = body.data.repository;
  const result = new Map<string, AssociatedPullRequestTitle[] | undefined>();
  const branch = repository.defaultBranchRef;
  input.shas.forEach((sha, i) => {
    const object = repository[`o${String(i)}`];
    const comparison = isRecord(branch) ? branch[`c${String(i)}`] : null;
    const connection = isRecord(object) ? object.associatedPullRequests : null;
    result.set(sha, isOutsideDefaultBranch(comparison, sha) ? parseAssociatedPullRequests(connection, sha) : undefined);
  });
  return result;
};
