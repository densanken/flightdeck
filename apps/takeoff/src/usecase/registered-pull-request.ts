import { errors } from "../domain/errors.js";

import type { GitHubClient, GitHubPullRequest } from "./github.js";
import type { RegisteredRepository } from "../domain/repository.js";

// PR は登録済みの owner/name で取得するため、rename の反映前に旧名を別リポジトリが使うと、その PR を取得してしまう
// GitHub は旧名が再利用されると redirect を打ち切るため、取得した PR の base repository ID を登録 ID と照合する
export const getRegisteredPullRequest = async (
  githubClient: GitHubClient,
  token: string,
  repo: RegisteredRepository,
  prNumber: number
): Promise<GitHubPullRequest> => {
  const pr = await githubClient.getPullRequest(token, repo.owner, repo.name, prNumber);
  if (String(pr.base.repo.id) !== repo.repoId) throw errors.repoMismatch();
  return pr;
};
