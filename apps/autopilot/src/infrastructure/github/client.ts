import { ApiError, GitHubPolicyGatewayImpl } from "@flightdeck/github-policy";

import type { MergeGateway } from "../../usecase/merge/dependencies.js";

export class GitHubGatewayImpl extends GitHubPolicyGatewayImpl implements MergeGateway {
  async merge(number: number, sha: string) {
    const repository = this.repoPath(this.repository);
    try {
      const result = await this.request.request(`/repos/${repository}/pulls/${String(number)}/merge`, "PUT", {
        sha,
        merge_method: "squash",
      });
      const data = result.data;
      if (!data || typeof data !== "object" || !("merged" in data) || typeof data.merged !== "boolean") {
        throw new Error("invalid merge response");
      }

      return { merged: data.merged, status: result.response.status };
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401 &&
        error.status !== 429 &&
        !(error.status === 403 && error.rateLimited)
      ) {
        return { merged: false, status: error.status };
      }

      throw error;
    }
  }
}
