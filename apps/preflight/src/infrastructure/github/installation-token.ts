import * as v from "valibot";

import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";

const tokenSchema = v.object({
  token: v.pipe(v.string(), v.nonEmpty()),
  expires_at: v.pipe(
    v.string(),
    v.check((value) => Number.isFinite(Date.parse(value)))
  ),
});

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

  const parsed = v.safeParse(tokenSchema, await readGitHubJson(response, "GITHUB_AUTH_FAILED", input.signal));
  if (!parsed.success) throw invalidShapeError(response, "GITHUB_AUTH_FAILED", "installation token");
  return parsed.output.token;
};
