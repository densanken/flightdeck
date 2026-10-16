import { errorDetail } from "../util/error-detail.js";
import { logger } from "../util/logger.js";

import type { GitHubClient, GitHubPullRequest, GitHubWorkflowFile } from "./github.js";

// none: 食い違いなし
// base_changed: fork の head が base の workflow の変更に追従していない
// pr_changed: PR 自体が workflow を変更している（base に追従しても解消しない）
export type ForkWorkflowDrift = "none" | "base_changed" | "pr_changed";

// head と base で sha が異なるか、片方にしかない entry の path を返す
// subdirectory の entry は tree の sha を持つため、中の file の変更もその entry の差として現れる
const differingPaths = (headFiles: GitHubWorkflowFile[], baseFiles: GitHubWorkflowFile[]): string[] => {
  const baseShas = new Map(baseFiles.map((file) => [file.path, file.sha]));
  const headPaths = new Set(headFiles.map((file) => file.path));
  return [
    ...headFiles.filter((file) => baseShas.get(file.path) !== file.sha).map((file) => file.path),
    ...baseFiles.filter((file) => !headPaths.has(file.path)).map((file) => file.path),
  ];
};

// GitHub は fork PR の head と base で .github/workflows が食い違うと、Workflows 権限を持たない GitHub App の merge を
// 403 "Resource not accessible by integration" で拒否する
// 同じ repository の branch からの PR は対象外のため調べない
// base は PR 取得時点の sha ではなく、merge 先となる branch の現在の内容と比べる
const detect = async (
  githubClient: GitHubClient,
  token: string,
  owner: string,
  repo: string,
  pr: GitHubPullRequest
): Promise<ForkWorkflowDrift> => {
  const [headFiles, baseFiles] = await Promise.all([
    githubClient.listWorkflowFiles(token, owner, repo, pr.head.sha),
    githubClient.listWorkflowFiles(token, owner, repo, pr.base.ref),
  ]);
  const differing = differingPaths(headFiles, baseFiles);
  if (differing.length === 0) return "none";

  // 食い違っている workflow を PR が変更していなければ、食い違いは base 側の変更だけで生じている
  const changedPaths = await githubClient.listPullRequestFilePaths(token, owner, repo, pr.number);
  const prChangesDiffering = differing.some((path) =>
    changedPaths.some((changed) => changed === path || changed.startsWith(`${path}/`))
  );
  return prChangesDiffering ? "pr_changed" : "base_changed";
};

// 判定は利用者への案内のための補足なので、失敗しても呼び出し元の処理は止めず、食い違いなしとして扱う
export const detectForkWorkflowDrift = async (
  githubClient: GitHubClient,
  token: string,
  owner: string,
  repo: string,
  pr: GitHubPullRequest
): Promise<ForkWorkflowDrift> => {
  if (pr.head.repo?.id === pr.base.repo.id) return "none";
  try {
    return await detect(githubClient, token, owner, repo, pr);
  } catch (error) {
    logger.log("warn", { event: "fork_workflow_drift_check_failed", error: errorDetail(error) });
    return "none";
  }
};
