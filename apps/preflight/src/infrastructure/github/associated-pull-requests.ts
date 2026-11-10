import { isRecord, positiveSafeInteger } from "../../util/type-guards.js";

import type { AssociatedPullRequestTitle } from "../../usecase/title-validation/dependencies.js";

export const parseAssociatedPullRequests = (
  connection: unknown,
  sha: string
): AssociatedPullRequestTitle[] | undefined => {
  if (
    !isRecord(connection) ||
    !Array.isArray(connection.nodes) ||
    connection.totalCount !== connection.nodes.length ||
    !isRecord(connection.pageInfo) ||
    connection.pageInfo.hasNextPage !== false
  )
    return undefined;

  const matches: AssociatedPullRequestTitle[] = [];
  const seen = new Set<number>();
  for (const node of connection.nodes as unknown[]) {
    if (
      !isRecord(node) ||
      !positiveSafeInteger(node.number) ||
      seen.has(node.number) ||
      typeof node.title !== "string" ||
      (node.state !== "OPEN" && node.state !== "CLOSED" && node.state !== "MERGED") ||
      typeof node.isDraft !== "boolean" ||
      typeof node.headRefOid !== "string" ||
      !node.headRefOid
    )
      return undefined;

    seen.add(node.number);
    if (node.state === "OPEN" && node.headRefOid === sha) {
      matches.push({ number: node.number, title: node.title, headSha: node.headRefOid, draft: node.isDraft });
    }
  }
  return matches.sort((a, b) => a.number - b.number);
};

export const isOutsideDefaultBranch = (comparison: unknown, sha: string): boolean =>
  isRecord(comparison) &&
  isRecord(comparison.headTarget) &&
  comparison.headTarget.oid === sha &&
  (comparison.status === "AHEAD" || comparison.status === "DIVERGED");
