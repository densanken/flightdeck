import { githubId } from "@flightdeck/validation";
import * as v from "valibot";

import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";

const appSchema = v.object({ slug: v.pipe(v.string(), v.maxLength(100), v.regex(/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/)) });

const userSchema = v.object({ id: githubId });

const parseAppSlug = (value: unknown): string | null => {
  const result = v.safeParse(appSchema, value);
  return result.success ? result.output.slug : null;
};

const parseUserId = (value: unknown): number | null => {
  const result = v.safeParse(userSchema, value);
  return result.success ? result.output.id : null;
};

export const getAuthenticatedAppBotUserId = async (input: {
  appJwt: string;
  installationToken: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<number> => {
  const appResponse = await githubRequest({
    url: `${GITHUB_API_BASE_URL}/app`,
    method: "GET",
    token: input.appJwt,
    expectedStatuses: [200],
    errorCode: "GITHUB_AUTH_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const slug = parseAppSlug(await readGitHubJson(appResponse, "GITHUB_AUTH_FAILED", input.signal));
  if (!slug) throw invalidShapeError(appResponse, "GITHUB_AUTH_FAILED", "App");

  const userResponse = await githubRequest({
    url: `${GITHUB_API_BASE_URL}/users/${encodeURIComponent(`${slug}[bot]`)}`,
    method: "GET",
    token: input.installationToken,
    expectedStatuses: [200],
    errorCode: "GITHUB_AUTH_FAILED",
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const userId = parseUserId(await readGitHubJson(userResponse, "GITHUB_AUTH_FAILED", input.signal));
  if (!userId) throw invalidShapeError(userResponse, "GITHUB_AUTH_FAILED", "App bot");
  return userId;
};
