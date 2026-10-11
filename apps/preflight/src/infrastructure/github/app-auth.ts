import { createGitHubAppJwt as signGitHubAppJwt } from "@flightdeck/github-app-jwt";

import { AppError } from "../../errors.js";

export const createGitHubAppJwt = async (input: {
  appId: string;
  privateKeyPem: string;
  now?: Date;
}): Promise<string> => {
  try {
    return await signGitHubAppJwt(input);
  } catch {
    throw new AppError("GITHUB_AUTH_FAILED", 502, "GitHub App JWT could not be generated");
  }
};
