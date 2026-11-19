import * as v from "valibot";

import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { BodyVersion } from "../../domain/merge-request.js";

const query = `query BodyHistory($number: Int!) {
  repository(owner: "densanken", name: "blog-contents") {
    pullRequest(number: $number) {
      body lastEditedAt
      userContentEdits(first: 100) { totalCount pageInfo { hasNextPage } nodes { diff deletedAt editor { __typename ... on User { databaseId } } } }
    }
  }
}`;

const responseSchema = v.object({
  repository: v.object({
    pullRequest: v.object({
      body: v.string(),
      lastEditedAt: v.nullable(v.string()),
      userContentEdits: v.nullable(
        v.object({
          totalCount: v.number(),
          pageInfo: v.object({ hasNextPage: v.boolean() }),
          nodes: v.array(v.unknown()),
        })
      ),
    }),
  }),
});

const bodyVersionSchema = v.object({
  diff: v.string(),
  deletedAt: v.nullable(v.string()),
  editor: v.object({ __typename: v.literal("User"), databaseId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)) }),
});

export class GitHubBodyHistory {
  constructor(private readonly input: { request: GitHubRequest; getToken: () => Promise<string> }) {}

  async versions(input: { number: number; body: string; authorId: number }): Promise<BodyVersion[] | null> {
    if (!this.input.request.canSpend(1)) throw new BoardingError("SUBREQUEST_LIMIT", "GitHub request budget exceeded");

    const data = await this.input.request.graphql(await this.input.getToken(), query, { number: input.number });
    const parsed = v.safeParse(responseSchema, data);
    if (!parsed.success) return null;

    const pr = parsed.output.repository.pullRequest;
    const history = pr.userContentEdits;
    if (
      pr.body !== input.body ||
      !history ||
      history.pageInfo.hasNextPage ||
      history.totalCount !== history.nodes.length
    ) {
      return null;
    }
    if (history.nodes.length === 0) {
      return pr.lastEditedAt === null ? [{ body: input.body, editorId: input.authorId }] : null;
    }

    const versions = v.safeParse(v.array(bodyVersionSchema), history.nodes);
    if (!versions.success || versions.output.some((version) => version.deletedAt !== null)) return null;

    const oldest = versions.output.at(-1);
    const newest = versions.output[0];
    // 履歴の件数とページで全版がそろうことは確かめているため、作成時刻との一致は求めない
    // 作成時の本文は PR 作成者が書くので、最古の版の編集者が PR 作成者であることだけを確かめる
    if (oldest?.editor.databaseId !== input.authorId || newest?.diff !== input.body) return null;

    return versions.output.toReversed().map((version) => ({ body: version.diff, editorId: version.editor.databaseId }));
  }
}
