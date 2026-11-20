import * as v from "valibot";

import { GitHubHttpError } from "./request.js";
import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { Logger } from "../../util/logger.js";

export class GitHubMerge {
  constructor(private readonly input: { request: GitHubRequest; getToken: () => Promise<string>; logger: Logger }) {}

  async write(input: { number: number; headSha: string }): Promise<"merged" | "changed" | "rejected"> {
    const token = await this.input.getToken();

    try {
      const response = await this.input.request.call({
        method: "PUT",
        path: `/repos/densanken/blog-contents/pulls/${String(input.number)}/merge`,
        token,
        body: { sha: input.headSha, merge_method: "squash" },
      });

      const result = v.safeParse(v.object({ merged: v.literal(true) }), response);
      if (!result.success) throw new BoardingError("INVALID_RESPONSE", "Merge was not confirmed");

      return "merged";
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 409) return "changed";
      if (error instanceof GitHubHttpError && !error.rateLimited && [403, 405, 422].includes(error.status)) {
        this.input.logger.log("warn", { event: "merge_rejected", number: input.number, status: error.status });
        return "rejected";
      }

      throw error;
    }
  }
}
