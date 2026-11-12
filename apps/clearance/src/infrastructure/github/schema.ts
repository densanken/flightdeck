import { z } from "zod";

export const actor = z
  .object({ __typename: z.string(), login: z.string().optional(), databaseId: z.number().nullable().optional() })
  .nullable();

export const blob = z.object({ isBinary: z.boolean(), isTruncated: z.boolean(), text: z.string().nullable() });

const entry = z.object({
  name: z.string(),
  type: z.string(),
  oid: z.string(),
});

const connection = <T extends z.ZodType>(item: T) =>
  z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(item) });

const context = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    checkSuite: z.object({ app: z.object({ databaseId: z.number().nullable(), slug: z.string() }).nullable() }),
  }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string() }),
]);

const commit = z.object({ oid: z.string(), statusCheckRollup: z.object({ contexts: connection(context) }).nullable() });

const review = z.object({
  databaseId: z.number().nullable().optional(),
  state: z.string(),
  author: actor,
  commit: z.object({ oid: z.string() }).nullable().optional(),
});

export const prResponse = z.object({
  rateLimit: z.object({ cost: z.number() }).nullable().optional(),
  repository: z.object({
    databaseId: z.number(),
    pullRequest: z
      .object({
        state: z.string(),
        isDraft: z.boolean(),
        body: z.string(),
        createdAt: z.string(),
        headRefName: z.string(),
        headRefOid: z.string(),
        baseRefName: z.string(),
        author: actor,
        editor: actor,
        lastEditedAt: z.string().nullable(),
        headRepository: z.object({ databaseId: z.number() }).nullable(),
        labels: connection(z.object({ name: z.string() })),
        files: connection(z.object({ path: z.string(), changeType: z.string() })),
        latestOpinionatedReviews: connection(review),
        latestReviews: connection(review),
        commits: z.object({ nodes: z.array(z.object({ commit })) }),
        potentialMergeCommit: commit.nullable(),
        baseRef: z
          .object({
            target: z.object({
              oid: z.string(),
              submodules: z.object({
                nodes: z.array(z.object({ path: z.string(), gitUrl: z.string() })),
                pageInfo: z.object({ hasNextPage: z.boolean() }),
              }),
            }),
          })
          .nullable(),
        recent: z.object({ pageCount: z.number().int().min(0).max(100) }),
        timelineItems: z.object({
          pageCount: z.number().int().min(0).max(100),
          pageInfo: z.object({ hasPreviousPage: z.boolean() }),
          nodes: z.array(z.record(z.string(), z.unknown())),
        }),
      })
      .nullable(),
  }),
});

export const configResponse = z.object({
  repository: z.object({
    yml: z.record(z.string(), z.unknown()).nullable(),
    yaml: z.record(z.string(), z.unknown()).nullable(),
  }),
});

const tree = z.object({ entries: z.array(entry).nullable() }).nullable();

export const treesResponse = z.object({ repository: z.object({ base: tree, head: tree }) });

export const compareResponse = z.object({
  repository: z
    .object({ defaultBranchRef: z.object({ compare: z.object({ status: z.string() }).nullable() }).nullable() })
    .nullable(),
});

export const ancestryResponse = z.object({ status: z.string() });

export const reviewResponse = z.object({ id: z.number().int() });

export const reviewStateResponse = z.object({ state: z.string() });

export const rulesResponse = z.array(z.object({ type: z.string(), parameters: z.unknown().optional() }));

export const requiredChecks = z.object({
  required_status_checks: z.array(z.object({ context: z.string(), integration_id: z.number().nullable().optional() })),
});

export const searchResponse = z.object({
  search: z.object({
    nodes: z.array(
      z.object({
        number: z.number(),
        headRefOid: z.string(),
        author: z.object({ databaseId: z.number().nullable().optional() }).nullable(),
        latestReviews: connection(review),
      })
    ),
  }),
});

const associatedItem = z.object({
  number: z.number(),
  state: z.string(),
  headRefOid: z.string(),
  potentialMergeCommit: z.object({ oid: z.string() }).nullable(),
  repository: z.object({ databaseId: z.number() }),
});

export const associatedResponse = z.object({
  repository: z.object({
    object: z.object({ associatedPullRequests: connection(associatedItem).nullable() }).nullable(),
  }),
});

export type PullRequest = NonNullable<z.output<typeof prResponse>["repository"]["pullRequest"]>;
