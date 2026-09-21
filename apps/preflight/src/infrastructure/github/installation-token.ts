import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";

interface InstallationTokenBody {
  token?: unknown;
  expires_at?: unknown;
}

export const createInstallationAccessToken = async (input: {
  installationId: number;
  appJwt: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<string> => {
  const response = await githubRequest({
    url: `${GITHUB_API_BASE_URL}/app/installations/${String(input.installationId)}/access_tokens`,
    method: "POST",
    token: input.appJwt,
    expectedStatuses: [201],
    errorCode: "GITHUB_AUTH_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    retry: true,
  });

  const body = (await readGitHubJson(response, "GITHUB_AUTH_FAILED", input.signal)) as InstallationTokenBody;
  if (
    typeof body.token !== "string" ||
    body.token.length === 0 ||
    typeof body.expires_at !== "string" ||
    !Number.isFinite(Date.parse(body.expires_at))
  ) {
    throw invalidShapeError(response, "GITHUB_AUTH_FAILED", "installation token");
  }
  return body.token;
};
