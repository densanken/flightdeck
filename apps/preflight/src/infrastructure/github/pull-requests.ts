import { commitSha, githubId } from "@flightdeck/validation";
import * as v from "valibot";

import {
  associatedObjectSchema,
  isOutsideDefaultBranch,
  parseAssociatedPullRequests,
} from "./associated-pull-requests.js";
import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";
import { GitHubError } from "../../errors.js";
import { MAX_OPEN_PULL_REQUEST_PAGES } from "../../usecase/title-validation/dependencies.js";

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

const nodeSchema = v.object({
  number: githubId,
  title: v.string(),
  state: v.literal("OPEN"),
  isDraft: v.boolean(),
  headRefOid: commitSha,
});

const openPageSchema = v.object({
  errors: v.optional(v.never()),
  data: v.object({
    repository: v.object({
      pullRequests: v.object({
        totalCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        nodes: v.array(nodeSchema),
        pageInfo: v.object({ hasNextPage: v.boolean(), endCursor: v.nullable(v.string()) }),
      }),
    }),
  }),
});

const parseOpenPullRequestPage = (value: unknown): OpenPullRequestPage | null => {
  const parsed = v.safeParse(openPageSchema, value);
  if (!parsed.success) return null;
  const page = parsed.output.data.repository.pullRequests;
  return {
    totalCount: page.totalCount,
    pullRequests: page.nodes.map((node) => ({
      number: node.number,
      title: node.title,
      headSha: node.headRefOid,
      draft: node.isDraft,
    })),
    hasNextPage: page.pageInfo.hasNextPage,
    endCursor: page.pageInfo.endCursor,
  };
};

const branchSchema = v.object({ compare: v.optional(v.unknown()) });

const currentResponseSchema = v.object({
  errors: v.optional(v.unknown()),
  data: v.object({
    repository: v.object({
      pullRequest: v.object({
        title: v.string(),
        state: v.picklist(["OPEN", "CLOSED", "MERGED"]),
        isDraft: v.boolean(),
        headRefOid: commitSha,
      }),
      defaultBranchRef: v.optional(v.unknown()),
      object: v.optional(v.unknown()),
    }),
  }),
});

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
  const parsed = v.safeParse(currentResponseSchema, await readGitHubJson(response, "GITHUB_API_FAILED", input.signal));
  if (!parsed.success) throw invalidShapeError(response, "GITHUB_API_FAILED", "pull request");
  const repository = parsed.output.data.repository;
  const pr = repository.pullRequest;
  const current: PullRequestTitleState = {
    title: pr.title,
    state: pr.state === "OPEN" ? "open" : "closed",
    draft: pr.isDraft,
    headSha: pr.headRefOid,
  };
  const branch = v.safeParse(branchSchema, repository.defaultBranchRef);
  const object = v.safeParse(associatedObjectSchema, repository.object);
  const associatedPullRequests =
    parsed.output.errors === undefined &&
    isOutsideDefaultBranch(branch.success ? branch.output.compare : undefined, input.headSha)
      ? parseAssociatedPullRequests(object.success ? object.output.associatedPullRequests : undefined, input.headSha)
      : undefined;
  return { current, associatedPullRequests };
};
