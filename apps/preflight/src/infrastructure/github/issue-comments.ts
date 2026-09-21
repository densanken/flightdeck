import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, nextPageUrl, readGitHubJson } from "./request.js";
import { GitHubError } from "../../errors.js";
import { positiveSafeInteger } from "../../util/type-guards.js";

import type { IssueComment } from "../../usecase/title-validation/dependencies.js";

const MAX_COMMENT_PAGES = 10;
const MAX_COMMENTS = 1_000;

const parseIssueComments = (value: unknown): IssueComment[] | null => {
  if (!Array.isArray(value)) return null;
  const comments: IssueComment[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const comment = item as Record<string, unknown>;
    if (!positiveSafeInteger(comment.id)) return null;
    if (comment.body !== null && typeof comment.body !== "string") return null;
    if (comment.user !== null) {
      if (typeof comment.user !== "object" || !positiveSafeInteger((comment.user as Record<string, unknown>).id)) {
        return null;
      }
    }
    comments.push({
      id: comment.id,
      body: comment.body,
      user: comment.user === null ? null : { id: (comment.user as { id: number }).id },
    });
  }
  return comments;
};

export const listIssueComments = async (input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<IssueComment[]> => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const commentsPath = `/repos/${owner}/${repo}/issues/${String(input.pullRequestNumber)}/comments`;
  let url = `${GITHUB_API_BASE_URL}${commentsPath}?per_page=100&page=1`;
  const visited = new Set<string>();
  const comments: IssueComment[] = [];
  let page = 0;

  for (;;) {
    page += 1;
    if (visited.has(url)) throw new GitHubError("GITHUB_API_FAILED", "GitHub pagination cycle detected");
    visited.add(url);
    const response = await githubRequest({
      url,
      method: "GET",
      token: input.installationToken,
      expectedStatuses: [200],
      errorCode: "GITHUB_API_FAILED",
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
    const pageComments = parseIssueComments(await readGitHubJson(response, "GITHUB_API_FAILED", input.signal));
    if (!pageComments) throw invalidShapeError(response, "GITHUB_API_FAILED", "issue comments");
    comments.push(...pageComments);
    if (comments.length > MAX_COMMENTS) {
      throw new GitHubError("GITHUB_API_FAILED", "GitHub issue comments safety limit exceeded");
    }

    const next = nextPageUrl(response.headers.get("link"), url, commentsPath, {
      invalidUrl: "Invalid GitHub pagination URL",
      invalidPath: "Invalid GitHub pagination path",
    });
    if (!next) return comments;
    if (page === MAX_COMMENT_PAGES) {
      throw new GitHubError("GITHUB_API_FAILED", "GitHub issue comments page limit exceeded");
    }
    url = next;
  }
};

export const createIssueComment = async (input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  body: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<void> => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  await githubRequest({
    url: `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues/${String(input.pullRequestNumber)}/comments`,
    method: "POST",
    token: input.installationToken,
    body: { body: input.body },
    expectedStatuses: [201],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
};

export const updateIssueComment = async (input: {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<void> => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  await githubRequest({
    url: `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues/comments/${String(input.commentId)}`,
    method: "PATCH",
    token: input.installationToken,
    body: { body: input.body },
    expectedStatuses: [200],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
};

export const deleteIssueComment = async (input: {
  owner: string;
  repo: string;
  commentId: number;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<void> => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  await githubRequest({
    url: `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues/comments/${String(input.commentId)}`,
    method: "DELETE",
    token: input.installationToken,
    expectedStatuses: [204, 404],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
};
