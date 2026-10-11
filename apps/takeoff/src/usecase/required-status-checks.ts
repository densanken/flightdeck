import { AppError } from "../domain/errors.js";

import type { GitHubClient, GitHubRequiredStatusCheck } from "./github.js";

// null は「GitHub plan の制限で Rules API 自体を利用できない」を表す
// API が利用可能だが required_status_checks rule がない場合の [] と区別し、後者は従来どおり fail-closed にする
export const getRequiredStatusChecksForMergeGate = async (
  githubClient: GitHubClient,
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<GitHubRequiredStatusCheck[] | null> => {
  try {
    return await githubClient.getRequiredStatusChecksForBranch(token, owner, repo, branch);
  } catch (error) {
    if (error instanceof AppError && error.type === "github_rules_api_unavailable") {
      return null;
    }
    throw error;
  }
};
