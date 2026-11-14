import { z } from "zod";

const actor = z
  .object({ __typename: z.string(), login: z.string().optional(), databaseId: z.number().nullable().optional() })
  .nullable();

const review = z.object({
  databaseId: z.number().nullable().optional(),
  state: z.string(),
  author: actor,
  commit: z.object({ oid: z.string() }).nullable().optional(),
});

export const reviewResponse = z.object({ id: z.number().int() });

export const reviewStateResponse = z.object({ state: z.string() });

export const searchResponse = z.object({
  search: z.object({
    nodes: z.array(
      z.object({
        number: z.number(),
        headRefOid: z.string(),
        author: z.object({ databaseId: z.number().nullable().optional() }).nullable(),
        latestReviews: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(review) }),
      })
    ),
  }),
});
