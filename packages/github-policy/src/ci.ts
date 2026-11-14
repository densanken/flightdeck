import { evaluateCi } from "@flightdeck/rules";

import type { PolicyGateway } from "./evaluate.js";
import type { PolicyPullRequest } from "@flightdeck/rules";

export const ciStatus = async (
  github: Pick<PolicyGateway, "rules">,
  pr: Pick<PolicyPullRequest, "checks" | "statuses" | "baseBranch">
): Promise<ReturnType<typeof evaluateCi>> => {
  const initial = evaluateCi(pr.checks, pr.statuses, []);
  if (initial !== "passed") return initial;

  const rules = await github.rules(pr.baseBranch);
  return evaluateCi(pr.checks, pr.statuses, rules);
};
