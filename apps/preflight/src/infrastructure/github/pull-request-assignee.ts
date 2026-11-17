import * as v from "valibot";

import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";

const assigneeSchema = v.object({ assignees: v.array(v.object({ login: v.string() })) });

const parseAssigneeLogins = (body: unknown): string[] | null => {
  const parsed = v.safeParse(assigneeSchema, body);
  return parsed.success ? parsed.output.assignees.map((assignee) => assignee.login) : null;
};

export const addPullRequestAuthorAsAssignee = async (input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  author: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<{ assigned: boolean; assignees: string[] }> => {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const response = await githubRequest({
    url: `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues/${String(input.pullRequestNumber)}/assignees`,
    method: "POST",
    token: input.installationToken,
    body: { assignees: [input.author] },
    expectedStatuses: [201],
    errorCode: "GITHUB_API_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });

  const assignees = parseAssigneeLogins(await readGitHubJson(response, "GITHUB_API_FAILED", input.signal));
  if (!assignees) throw invalidShapeError(response, "GITHUB_API_FAILED", "assignee");

  const normalizedAuthor = input.author.toLowerCase();
  return {
    assigned: assignees.some((login) => login.toLowerCase() === normalizedAuthor),
    assignees,
  };
};
