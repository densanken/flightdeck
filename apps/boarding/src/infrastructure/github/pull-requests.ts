import * as v from "valibot";

import { readCi, statusCheckRollup } from "./ci.js";
import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { CiData } from "../../domain/merge.js";

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

const searchSchema = v.object({
  items: v.array(v.object({ number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)) })),
});

const associatedFields = `associatedPullRequests(first:100) { totalCount nodes { number state baseRefName headRefOid potentialMergeCommit { oid } repository { databaseId } } }`;
const associatedQuery = `query($oid:GitObjectID!) { repository(owner:"densanken",name:"blog-contents") { object(oid:$oid) { ... on Commit { ${statusCheckRollup} ${associatedFields} parents(first:2) { nodes { ${associatedFields} } } } } } }`;
const associatedItem = v.object({
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  state: v.string(),
  baseRefName: v.string(),
  headRefOid: v.string(),
  potentialMergeCommit: v.nullable(v.object({ oid: v.string() })),
  repository: v.object({ databaseId: v.number() }),
});
const associatedConnection = v.nullable(v.object({ totalCount: v.number(), nodes: v.array(associatedItem) }));
const associatedSchema = v.object({
  repository: v.object({
    object: v.nullable(
      v.object({
        statusCheckRollup: v.unknown(),
        associatedPullRequests: associatedConnection,
        parents: v.object({ nodes: v.array(v.object({ associatedPullRequests: associatedConnection })) }),
      })
    ),
  }),
});

export class GitHubOpenPullRequests {
  constructor(
    private readonly input: {
      request: GitHubRequest;
      getToken: () => Promise<string>;
    }
  ) {}

  async associated(sha: string, repositoryId: number): Promise<{ numbers: number[]; ci: CiData | null }> {
    const token = await this.input.getToken();
    const response = await this.input.request.graphql(token, associatedQuery, { oid: sha });
    const parsed = v.safeParse(associatedSchema, response);
    if (!parsed.success || !parsed.output.repository.object) {
      throw new BoardingError("INVALID_RESPONSE", "Associated pull requests are unavailable");
    }

    const commit = parsed.output.repository.object;
    const connections = [
      commit.associatedPullRequests,
      ...commit.parents.nodes.map((parent) => parent.associatedPullRequests),
    ];

    if (connections.some((connection) => !connection || connection.totalCount !== connection.nodes.length)) {
      throw new BoardingError("INCOMPLETE_PAGINATION", "Associated pull requests are incomplete");
    }

    const numbers = connections
      .flatMap((connection) => connection?.nodes ?? [])
      .filter(
        (pr) =>
          pr.state === "OPEN" &&
          pr.baseRefName === "main" &&
          pr.repository.databaseId === repositoryId &&
          (pr.headRefOid === sha || pr.potentialMergeCommit?.oid === sha)
      )
      .map((pr) => pr.number);

    return {
      numbers: numbers.length > 0 ? numbers : await this.search(token, sha),
      ci: readCi(commit.statusCheckRollup),
    };
  }

  // fork の PR は head のコミットが base に関連付かず associatedPullRequests に現れないため、検索で補う
  private async search(token: string, sha: string): Promise<number[]> {
    const q = encodeURIComponent(`repo:densanken/blog-contents is:pr is:open base:main ${sha}`);
    const response = await this.input.request.call({ method: "GET", path: `/search/issues?q=${q}`, token });
    const parsed = v.safeParse(searchSchema, response);
    if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "Pull request search is invalid");

    return parsed.output.items.map((item) => item.number);
  }

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
