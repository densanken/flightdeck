import { commitSha, githubId } from "@flightdeck/validation";
import * as v from "valibot";

export const actor = v.nullable(
  v.object({ __typename: v.string(), login: v.optional(v.string()), databaseId: v.nullish(githubId) })
);

export const blob = v.object({ isBinary: v.boolean(), isTruncated: v.boolean(), text: v.nullable(v.string()) });

const entry = v.object({ name: v.string(), type: v.string(), oid: commitSha });

const connection = <T extends v.GenericSchema>(item: T) =>
  v.object({ totalCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)), nodes: v.array(item) });

const context = v.variant("__typename", [
  v.object({
    __typename: v.literal("CheckRun"),
    name: v.string(),
    status: v.string(),
    conclusion: v.nullable(v.string()),
    checkSuite: v.object({ app: v.nullable(v.object({ databaseId: v.nullable(githubId), slug: v.string() })) }),
  }),
  v.object({ __typename: v.literal("StatusContext"), context: v.string(), state: v.string() }),
]);

const commit = v.object({ oid: commitSha, statusCheckRollup: v.nullable(v.object({ contexts: connection(context) })) });

const review = v.object({
  databaseId: v.nullish(githubId),
  state: v.string(),
  author: actor,
  commit: v.nullish(v.object({ oid: commitSha })),
});

const pageCount = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(100));

export const prResponse = v.object({
  rateLimit: v.nullish(v.object({ cost: v.number() })),
  repository: v.object({
    databaseId: githubId,
    pullRequest: v.nullable(
      v.object({
        state: v.string(),
        isDraft: v.boolean(),
        title: v.string(),
        body: v.string(),
        createdAt: v.string(),
        headRefName: v.string(),
        headRefOid: commitSha,
        author: actor,
        editor: actor,
        lastEditedAt: v.nullable(v.string()),
        headRepository: v.nullable(v.object({ databaseId: githubId })),
        labels: connection(v.object({ name: v.string() })),
        files: connection(v.object({ path: v.string(), changeType: v.string() })),
        latestOpinionatedReviews: connection(review),
        latestReviews: connection(review),
        commits: v.object({ nodes: v.array(v.object({ commit })) }),
        potentialMergeCommit: v.nullable(commit),
        baseRef: v.nullable(
          v.object({
            target: v.object({
              oid: commitSha,
              submodules: v.object({
                nodes: v.array(v.object({ path: v.string(), gitUrl: v.string() })),
                pageInfo: v.object({ hasNextPage: v.boolean() }),
              }),
            }),
          })
        ),
        recent: v.object({ pageCount }),
        timelineItems: v.object({
          pageCount,
          pageInfo: v.object({ hasPreviousPage: v.boolean() }),
          nodes: v.array(v.record(v.string(), v.unknown())),
        }),
      })
    ),
  }),
});

export const configResponse = v.object({
  repository: v.object({
    yml: v.nullable(v.record(v.string(), v.unknown())),
    yaml: v.nullable(v.record(v.string(), v.unknown())),
  }),
});

const tree = v.nullable(v.object({ entries: v.nullable(v.array(entry)) }));

export const treesResponse = v.object({ repository: v.object({ base: tree, head: tree }) });

export const compareResponse = v.object({
  repository: v.nullable(
    v.object({
      defaultBranchRef: v.nullable(v.object({ compare: v.nullable(v.object({ status: v.string() })) })),
    })
  ),
});

export const ancestryResponse = v.object({ status: v.string() });

const associatedItem = v.object({
  number: githubId,
  state: v.string(),
  headRefOid: commitSha,
  potentialMergeCommit: v.nullable(v.object({ oid: commitSha })),
  repository: v.object({ databaseId: githubId }),
});

export const associatedResponse = v.object({
  repository: v.object({
    object: v.nullable(
      v.object({
        associatedPullRequests: v.nullable(connection(associatedItem)),
        parents: v.object({
          nodes: v.array(v.object({ associatedPullRequests: v.nullable(connection(associatedItem)) })),
        }),
      })
    ),
  }),
});

export type PullRequest = NonNullable<v.InferOutput<typeof prResponse>["repository"]["pullRequest"]>;
