import { commitSha, githubId } from "@flightdeck/validation";
import * as v from "valibot";

const actor = v.nullable(
  v.object({
    __typename: v.string(),
    login: v.optional(v.string()),
    databaseId: v.nullish(githubId),
  })
);

const review = v.object({
  databaseId: v.nullish(githubId),
  state: v.string(),
  author: actor,
  commit: v.nullish(v.object({ oid: commitSha })),
});

export const reviewResponse = v.object({ id: githubId });

export const reviewStateResponse = v.object({ state: v.string() });

export const searchResponse = v.object({
  search: v.object({
    nodes: v.array(
      v.object({
        number: githubId,
        headRefOid: commitSha,
        author: v.nullable(v.object({ databaseId: v.nullish(githubId) })),
        latestReviews: v.object({
          totalCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
          nodes: v.array(review),
        }),
      })
    ),
  }),
});
