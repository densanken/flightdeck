import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, nextPageUrl, readGitHubJson } from "./request.js";
import { GitHubError } from "../../errors.js";
import { positiveSafeInteger } from "../../util/type-guards.js";

import type { AssociatedPullRequestTitle, PullRequestTitleState } from "../../usecase/title-validation/dependencies.js";
import type { Logger } from "../../util/logger.js";

const OPEN_PULL_REQUESTS_QUERY = `
  query OpenPullRequests($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(
        states: OPEN
        first: 100
        after: $cursor
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        totalCount
        nodes {
          number
          title
          state
          isDraft
          headRefOid
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// 1 ページ 100 件で 5,000 件相当
// 上限内で完了すれば成功、上限を超えるページが必要になったら安全側に倒し、
// head SHA 一致 PR の取得を「完了できなかった」失敗として扱う
const MAX_OPEN_PULL_REQUEST_PAGES = 50;

interface ParsedPullRequest {
  title: string;
  state: "closed" | "open";
  draft: boolean;
  headSha: string;
}

interface CommitAssociatedPullRequest extends AssociatedPullRequestTitle {
  state: "closed" | "open";
}

interface OpenPullRequestPage {
  totalCount: number;
  pullRequests: AssociatedPullRequestTitle[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const parsePullRequest = (value: unknown): ParsedPullRequest | null => {
  if (typeof value !== "object" || value === null) return null;
  const pullRequest = value as Record<string, unknown>;
  if (
    typeof pullRequest.title !== "string" ||
    (pullRequest.state !== "closed" && pullRequest.state !== "open") ||
    typeof pullRequest.draft !== "boolean" ||
    typeof pullRequest.head !== "object" ||
    pullRequest.head === null
  ) {
    return null;
  }
  const headSha = (pullRequest.head as Record<string, unknown>).sha;
  if (typeof headSha !== "string" || headSha.length === 0) return null;
  return {
    title: pullRequest.title,
    state: pullRequest.state,
    draft: pullRequest.draft,
    headSha,
  };
};

const parseCommitAssociatedPullRequest = (value: unknown): CommitAssociatedPullRequest | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const parsed = parsePullRequest(value);
  if (!parsed || !positiveSafeInteger(record.number)) return null;
  return {
    number: record.number,
    title: parsed.title,
    headSha: parsed.headSha,
    draft: parsed.draft,
    state: parsed.state,
  };
};

const parseOpenPullRequestPage = (value: unknown): OpenPullRequestPage | null => {
  if (typeof value !== "object" || value === null) return null;
  const response = value as Record<string, unknown>;
  if (response.errors !== undefined || typeof response.data !== "object" || response.data === null) return null;
  const repository = (response.data as Record<string, unknown>).repository;
  if (typeof repository !== "object" || repository === null) return null;
  const connection = (repository as Record<string, unknown>).pullRequests;
  if (typeof connection !== "object" || connection === null) return null;
  const pullRequests = connection as Record<string, unknown>;
  if (
    !Array.isArray(pullRequests.nodes) ||
    (!positiveSafeInteger(pullRequests.totalCount) && pullRequests.totalCount !== 0)
  ) {
    return null;
  }
  if (typeof pullRequests.pageInfo !== "object" || pullRequests.pageInfo === null) return null;
  const pageInfo = pullRequests.pageInfo as Record<string, unknown>;
  if (
    typeof pageInfo.hasNextPage !== "boolean" ||
    (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
  ) {
    return null;
  }

  const nodes: AssociatedPullRequestTitle[] = [];
  for (const item of pullRequests.nodes as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const node = item as Record<string, unknown>;
    if (
      !positiveSafeInteger(node.number) ||
      typeof node.title !== "string" ||
      node.state !== "OPEN" ||
      typeof node.isDraft !== "boolean" ||
      typeof node.headRefOid !== "string" ||
      node.headRefOid.length === 0
    ) {
      return null;
    }
    nodes.push({ number: node.number, title: node.title, headSha: node.headRefOid, draft: node.isDraft });
  }
  return {
    totalCount: pullRequests.totalCount,
    pullRequests: nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  };
};

const listCommitAssociatedPullRequests = async (input: {
  owner: string;
  repo: string;
  headSha: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<AssociatedPullRequestTitle[]> => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const sha = encodeURIComponent(input.headSha);
  const path = `/repos/${owner}/${repo}/commits/${sha}/pulls`;
  let url = `${GITHUB_API_BASE_URL}${path}?per_page=100&page=1`;
  const visitedUrls = new Set<string>();
  const seenNumbers = new Set<number>();
  const matches: AssociatedPullRequestTitle[] = [];

  for (;;) {
    if (visitedUrls.has(url)) throw new GitHubError("GITHUB_API_FAILED", "GitHub pagination cycle detected");
    visitedUrls.add(url);
    const response = await githubRequest({
      url,
      method: "GET",
      token: input.installationToken,
      expectedStatuses: [200],
      errorCode: "GITHUB_API_FAILED",
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
    const body = await readGitHubJson(response, "GITHUB_API_FAILED", input.signal);
    if (!Array.isArray(body)) throw invalidShapeError(response, "GITHUB_API_FAILED", "commit-associated pull requests");
    for (const value of body as unknown[]) {
      const pullRequest = parseCommitAssociatedPullRequest(value);
      if (!pullRequest) throw invalidShapeError(response, "GITHUB_API_FAILED", "commit-associated pull requests");
      if (seenNumbers.has(pullRequest.number)) {
        throw new GitHubError("GITHUB_API_FAILED", "Duplicate pull request in GitHub pagination response");
      }
      seenNumbers.add(pullRequest.number);
      if (pullRequest.state === "open" && pullRequest.headSha === input.headSha) {
        matches.push({
          number: pullRequest.number,
          title: pullRequest.title,
          headSha: pullRequest.headSha,
          draft: pullRequest.draft,
        });
      }
    }
    const next = nextPageUrl(response.headers.get("link"), url, path, {
      invalidUrl: "Invalid GitHub pull request pagination URL",
      invalidPath: "Invalid GitHub pull request pagination URL",
    });
    if (!next) return matches.sort((left, right) => left.number - right.number);
    url = next;
  }
};

const totalCountMismatchWarning = (input: {
  logger: Logger;
  deliveryId: string;
  owner: string;
  repo: string;
  headSha: string;
  expectedTotalCount: number;
  observedTotalCount: number;
}): void => {
  input.logger.log("warn", {
    event: "github_webhook_consume",
    feature: "title-validation",
    result: "open_pull_request_total_count_mismatch",
    deliveryId: input.deliveryId,
    repository: `${input.owner}/${input.repo}`,
    headSha: input.headSha,
    expectedTotalCount: input.expectedTotalCount,
    observedTotalCount: input.observedTotalCount,
  });
};

const listAllOpenPullRequestsForHeadSha = async (input: {
  owner: string;
  repo: string;
  headSha: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  logger: Logger;
  deliveryId: string;
}): Promise<AssociatedPullRequestTitle[]> => {
  const seenPullRequestNumbers = new Set<number>();
  const seenCursors = new Set<string>();
  const associatedPullRequests: AssociatedPullRequestTitle[] = [];
  let totalPullRequests = 0;
  let expectedTotalCount: number | undefined;
  let cursor: string | null = null;
  let pageCount = 0;

  for (;;) {
    pageCount += 1;
    if (pageCount > MAX_OPEN_PULL_REQUEST_PAGES) {
      throw new GitHubError("GITHUB_API_FAILED", "GitHub open pull request pagination exceeded the page limit");
    }
    const response = await githubRequest({
      url: `${GITHUB_API_BASE_URL}/graphql`,
      method: "POST",
      token: input.installationToken,
      body: {
        query: OPEN_PULL_REQUESTS_QUERY,
        variables: { owner: input.owner, repo: input.repo, cursor },
      },
      expectedStatuses: [200],
      errorCode: "GITHUB_API_FAILED",
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
    const pullRequestPage = parseOpenPullRequestPage(await readGitHubJson(response, "GITHUB_API_FAILED", input.signal));
    if (!pullRequestPage) throw invalidShapeError(response, "GITHUB_API_FAILED", "pull requests");
    // totalCount は pagination 中の open PR 増減で変わりうる
    // head SHA 一致 PR を取得できたかどうかの成功判定には使わず、診断用の警告として記録するだけにする
    expectedTotalCount ??= pullRequestPage.totalCount;
    if (pullRequestPage.totalCount !== expectedTotalCount) {
      totalCountMismatchWarning({
        logger: input.logger,
        deliveryId: input.deliveryId,
        owner: input.owner,
        repo: input.repo,
        headSha: input.headSha,
        expectedTotalCount,
        observedTotalCount: pullRequestPage.totalCount,
      });
    }

    totalPullRequests += pullRequestPage.pullRequests.length;
    for (const pullRequest of pullRequestPage.pullRequests) {
      if (seenPullRequestNumbers.has(pullRequest.number)) {
        throw new GitHubError("GITHUB_API_FAILED", "Duplicate pull request in GitHub pagination response");
      }
      seenPullRequestNumbers.add(pullRequest.number);
      if (pullRequest.headSha === input.headSha) associatedPullRequests.push(pullRequest);
    }

    if (!pullRequestPage.hasNextPage) {
      if (totalPullRequests !== expectedTotalCount) {
        totalCountMismatchWarning({
          logger: input.logger,
          deliveryId: input.deliveryId,
          owner: input.owner,
          repo: input.repo,
          headSha: input.headSha,
          expectedTotalCount,
          observedTotalCount: totalPullRequests,
        });
      }
      return associatedPullRequests.sort((left, right) => left.number - right.number);
    }
    const nextCursor = pullRequestPage.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new GitHubError("GITHUB_API_FAILED", "Invalid GitHub GraphQL pagination cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
};

export const getCurrentPullRequestTitleState = async (input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<PullRequestTitleState> => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const response = await githubRequest({
    url: `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/pulls/${String(input.pullRequestNumber)}`,
    method: "GET",
    token: input.installationToken,
    expectedStatuses: [200],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const pullRequest = parsePullRequest(await readGitHubJson(response, "GITHUB_API_FAILED", input.signal));
  if (!pullRequest) throw invalidShapeError(response, "GITHUB_API_FAILED", "pull request");
  return { title: pullRequest.title, headSha: pullRequest.headSha, state: pullRequest.state, draft: pullRequest.draft };
};

export const listOpenPullRequestsForHeadSha = async (input: {
  owner: string;
  repo: string;
  headSha: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  logger: Logger;
  deliveryId: string;
}): Promise<AssociatedPullRequestTitle[]> => {
  const associated = await listCommitAssociatedPullRequests(input);
  // GitHub の仕様では default branch 上の commit に対して open PR が返らないため、その場合だけ全 open PR を走査する
  return associated.length > 0 ? associated : listAllOpenPullRequestsForHeadSha(input);
};
