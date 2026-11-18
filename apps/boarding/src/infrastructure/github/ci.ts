import * as v from "valibot";

import type { CiData } from "../../domain/merge.js";

export const statusCheckRollup = `statusCheckRollup { contexts(first:100) { totalCount nodes { __typename
  ... on CheckRun { name status conclusion checkSuite { app { databaseId slug } } }
  ... on StatusContext { context state }
} } }`;

const contextSchema = v.variant("__typename", [
  v.object({
    __typename: v.literal("CheckRun"),
    name: v.string(),
    status: v.string(),
    conclusion: v.nullable(v.string()),
    checkSuite: v.object({ app: v.nullable(v.object({ databaseId: v.nullable(v.number()), slug: v.string() })) }),
  }),
  v.object({ __typename: v.literal("StatusContext"), context: v.string(), state: v.string() }),
]);

const rollupSchema = v.object({
  contexts: v.object({ totalCount: v.number(), nodes: v.array(contextSchema) }),
});

export const readCi = (value: unknown): CiData | null => {
  if (value === null) return { checks: [], statuses: [] };

  const parsed = v.safeParse(rollupSchema, value);
  if (!parsed.success || parsed.output.contexts.totalCount !== parsed.output.contexts.nodes.length) return null;

  const contexts = parsed.output.contexts.nodes;
  return {
    checks: contexts.flatMap((item) =>
      item.__typename === "CheckRun"
        ? [
            {
              name: item.name,
              status: item.status.toLowerCase(),
              conclusion: item.conclusion?.toLowerCase() ?? null,
              app:
                item.checkSuite.app?.databaseId == null
                  ? null
                  : { id: item.checkSuite.app.databaseId, slug: item.checkSuite.app.slug },
            },
          ]
        : []
    ),
    statuses: contexts.flatMap((item) =>
      item.__typename === "StatusContext"
        ? [{ context: item.context, state: item.state === "EXPECTED" ? "pending" : item.state.toLowerCase() }]
        : []
    ),
  };
};
