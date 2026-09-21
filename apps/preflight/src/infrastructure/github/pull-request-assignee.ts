import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";

interface AssigneeResponseBody {
  assignees?: unknown;
}

const parseAssigneeLogins = (body: unknown): string[] | null => {
  if (typeof body !== "object" || body === null) return null;
  const assignees = (body as AssigneeResponseBody).assignees;
  if (!Array.isArray(assignees)) return null;

  const logins: string[] = [];
  for (const assignee of assignees as unknown[]) {
    if (typeof assignee !== "object" || assignee === null || !("login" in assignee)) return null;
    if (typeof assignee.login !== "string") return null;
    logins.push(assignee.login);
  }
  return logins;
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
