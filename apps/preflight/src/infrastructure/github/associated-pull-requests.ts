import { commitSha, githubId } from "@flightdeck/validation";
import * as v from "valibot";

import type { AssociatedPullRequestTitle } from "../../usecase/title-validation/dependencies.js";

export const associatedObjectSchema = v.object({ associatedPullRequests: v.optional(v.unknown()) });

const connectionSchema = v.object({
  totalCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  nodes: v.array(
    v.object({
      number: githubId,
      title: v.string(),
      state: v.picklist(["OPEN", "CLOSED", "MERGED"]),
      isDraft: v.boolean(),
      headRefOid: commitSha,
    })
  ),
  pageInfo: v.object({ hasNextPage: v.literal(false) }),
});

const comparisonSchema = v.object({
  status: v.picklist(["AHEAD", "DIVERGED"]),
  headTarget: v.object({ oid: commitSha }),
});

export const parseAssociatedPullRequests = (
  connection: unknown,
  sha: string
): AssociatedPullRequestTitle[] | undefined => {
  const parsed = v.safeParse(connectionSchema, connection);
  if (!parsed.success || parsed.output.totalCount !== parsed.output.nodes.length) return undefined;
  const seen = new Set<number>();
  const matches: AssociatedPullRequestTitle[] = [];
  for (const node of parsed.output.nodes) {
    if (seen.has(node.number)) return undefined;
    seen.add(node.number);
    if (node.state === "OPEN" && node.headRefOid === sha) {
      matches.push({ number: node.number, title: node.title, headSha: node.headRefOid, draft: node.isDraft });
    }
  }
  return matches.sort((a, b) => a.number - b.number);
};

export const isOutsideDefaultBranch = (comparison: unknown, sha: string): boolean => {
  const parsed = v.safeParse(comparisonSchema, comparison);
  return parsed.success && parsed.output.headTarget.oid === sha;
};
