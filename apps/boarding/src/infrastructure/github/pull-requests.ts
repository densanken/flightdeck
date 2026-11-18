import * as v from "valibot";

import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";

const query = `query OpenPullRequests($cursor: String) {
  repository(owner: "densanken", name: "blog-contents") {
    pullRequests(first: 100, after: $cursor, states: OPEN, baseRefName: "main") {
      nodes { number }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const responseSchema = v.object({
  repository: v.object({
    pullRequests: v.object({
      nodes: v.array(v.object({ number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)) })),
      pageInfo: v.object({ hasNextPage: v.boolean(), endCursor: v.nullable(v.string()) }),
    }),
  }),
});

export class GitHubOpenPullRequests {
  constructor(
    private readonly input: {
      request: GitHubRequest;
      getToken: () => Promise<string>;
    }
  ) {}

  async list(): Promise<number[]> {
    const token = await this.input.getToken();
    const numbers = new Set<number>();
    const cursors = new Set<string>();
    let cursor: string | null = null;

    for (;;) {
      const data = await this.input.request.graphql(token, query, { cursor });
      const parsed = v.safeParse(responseSchema, data);
      if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "GitHub pull request list is invalid");

      const { nodes, pageInfo } = parsed.output.repository.pullRequests;
      for (const node of nodes) numbers.add(node.number);
      if (!pageInfo.hasNextPage) return [...numbers];
      if (!pageInfo.endCursor || cursors.has(pageInfo.endCursor)) {
        throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub pull request pagination did not advance");
      }

      cursor = pageInfo.endCursor;
      cursors.add(cursor);
    }
  }
}
