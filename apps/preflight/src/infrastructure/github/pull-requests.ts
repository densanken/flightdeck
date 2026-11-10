import { isOutsideDefaultBranch, parseAssociatedPullRequests } from "./associated-pull-requests.js";
import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";
import { GitHubError } from "../../errors.js";
import { MAX_OPEN_PULL_REQUEST_PAGES } from "../../usecase/title-validation/dependencies.js";
import { isRecord, positiveSafeInteger } from "../../util/type-guards.js";

import type { AssociatedPullRequestTitle, PullRequestTitleState } from "../../usecase/title-validation/dependencies.js";
import type { Logger } from "../../util/logger.js";

const CURRENT_POLICY_QUERY = `
  query CurrentPolicy($owner: String!, $repo: String!, $number: Int!, $sha: String!, $oid: GitObjectID!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) { title state isDraft headRefOid }
      object(oid: $oid) {
        ... on Commit {
          associatedPullRequests(first: 100) {
            totalCount
            nodes { number title state isDraft headRefOid }
            pageInfo { hasNextPage }
          }
        }
      }
      defaultBranchRef { compare(headRef: $sha) { status headTarget { oid } } }
    }
  }
`;

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

interface OpenPullRequestPage {
  totalCount: number;
  pullRequests: AssociatedPullRequestTitle[];
  hasNextPage: boolean;
  endCursor: string | null;
}

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

export const listOpenPullRequestsForHeadShas = async (input: {
  owner: string;
  repo: string;
  headShas: string[];
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  logger: Logger;
  deliveryId: string;
}): Promise<AssociatedPullRequestTitle[]> => {
  const seenPullRequestNumbers = new Set<number>();
  const seenCursors = new Set<string>();
  const associatedPullRequests: AssociatedPullRequestTitle[] = [];
  const headShas = new Set(input.headShas);
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
    // pagination 中の件数変化では一覧の網羅性を確認できない
    expectedTotalCount ??= pullRequestPage.totalCount;
    if (pullRequestPage.totalCount !== expectedTotalCount) {
      totalCountMismatchWarning({
        logger: input.logger,
        deliveryId: input.deliveryId,
        owner: input.owner,
        repo: input.repo,
        headSha: input.headShas.join(","),
        expectedTotalCount,
        observedTotalCount: pullRequestPage.totalCount,
      });
      throw new GitHubError("GITHUB_API_FAILED", "GitHub open pull request count changed during pagination");
    }

    totalPullRequests += pullRequestPage.pullRequests.length;
    for (const pullRequest of pullRequestPage.pullRequests) {
      if (seenPullRequestNumbers.has(pullRequest.number)) {
        throw new GitHubError("GITHUB_API_FAILED", "Duplicate pull request in GitHub pagination response");
      }
      seenPullRequestNumbers.add(pullRequest.number);
      if (headShas.has(pullRequest.headSha)) associatedPullRequests.push(pullRequest);
    }

    if (!pullRequestPage.hasNextPage) {
      if (totalPullRequests !== expectedTotalCount) {
        totalCountMismatchWarning({
          logger: input.logger,
          deliveryId: input.deliveryId,
          owner: input.owner,
          repo: input.repo,
          headSha: input.headShas.join(","),
          expectedTotalCount,
          observedTotalCount: totalPullRequests,
        });
        throw new GitHubError("GITHUB_API_FAILED", "GitHub open pull request count did not match pagination");
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

export const getCurrentPolicyState = async (input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<{
  current: PullRequestTitleState;
  associatedPullRequests: AssociatedPullRequestTitle[] | undefined;
}> => {
  const response = await githubRequest({
    url: `${GITHUB_API_BASE_URL}/graphql`,
    method: "POST",
    token: input.installationToken,
    body: {
      query: CURRENT_POLICY_QUERY,
      variables: {
        owner: input.owner,
        repo: input.repo,
        number: input.pullRequestNumber,
        sha: input.headSha,
        oid: input.headSha,
      },
    },
    expectedStatuses: [200],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const body: unknown = await readGitHubJson(response, "GITHUB_API_FAILED", input.signal);
  const repository =
    isRecord(body) && isRecord(body.data) && isRecord(body.data.repository) ? body.data.repository : {};
  const pr = isRecord(repository.pullRequest) ? repository.pullRequest : undefined;
  if (
    !pr ||
    typeof pr.title !== "string" ||
    (pr.state !== "OPEN" && pr.state !== "CLOSED" && pr.state !== "MERGED") ||
    typeof pr.isDraft !== "boolean" ||
    typeof pr.headRefOid !== "string" ||
    !pr.headRefOid
  ) {
    throw invalidShapeError(response, "GITHUB_API_FAILED", "pull request");
  }
  const current: PullRequestTitleState = {
    title: pr.title,
    state: pr.state === "OPEN" ? "open" : "closed",
    draft: pr.isDraft,
    headSha: pr.headRefOid,
  };
  const comparison = isRecord(repository.defaultBranchRef) ? repository.defaultBranchRef.compare : undefined;
  const object = isRecord(repository.object) ? repository.object : undefined;
  const associatedPullRequests =
    isRecord(body) && body.errors === undefined && isOutsideDefaultBranch(comparison, input.headSha)
      ? parseAssociatedPullRequests(object?.associatedPullRequests, input.headSha)
      : undefined;
  return { current, associatedPullRequests };
};
