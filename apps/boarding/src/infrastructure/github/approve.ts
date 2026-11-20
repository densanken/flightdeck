import * as v from "valibot";

import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";

export class GitHubApprove {
  constructor(
    private readonly input: {
      request: GitHubRequest;
      getToken: () => Promise<string>;
      botUserId: number;
      verify: (number: number, baseSha: string, headSha: string) => Promise<void>;
    }
  ) {}

  async write(input: { number: number; baseSha: string; headSha: string }): Promise<void> {
    const token = await this.input.getToken();
    await this.input.verify(input.number, input.baseSha, input.headSha);

    const updated = await this.input.request.call({
      method: "POST",
      path: `/repos/densanken/blog-contents/pulls/${String(input.number)}/reviews`,
      token,
      body: { event: "APPROVE", commit_id: input.headSha },
    });

    const checked = v.safeParse(
      v.object({ user: v.object({ id: v.number() }), state: v.literal("APPROVED"), commit_id: v.string() }),
      updated
    );
    if (
      !checked.success ||
      checked.output.user.id !== this.input.botUserId ||
      checked.output.commit_id !== input.headSha
    ) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub approval was not confirmed");
    }
  }
}
