import { GITHUB_API_BASE_URL, githubRequest, invalidShapeError, readGitHubJson } from "./request.js";
import { positiveSafeInteger } from "../../util/type-guards.js";

const parseAppSlug = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const slug = (value as Record<string, unknown>).slug;
  return typeof slug === "string" && slug.length <= 100 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(slug) ? slug : null;
};

const parseUserId = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as Record<string, unknown>).id;
  return positiveSafeInteger(id) ? id : null;
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
