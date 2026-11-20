import { needsTitleTypePolicy } from "../../domain/title-policy.js";
import { titleTypePolicy } from "../../domain/title-types.js";

import type { AssociatedPullRequestTitle, PullRequestTitleState, TitleValidationGateway } from "./dependencies.js";

interface PolicyInputs {
  gateway: TitleValidationGateway;
  coordinates: { owner: string; repo: string };
  pullRequests: AssociatedPullRequestTitle[];
  signal: AbortSignal;
}

export const loadAssociatedTitleTypePolicies = async ({
  gateway,
  coordinates,
  pullRequests,
  signal,
  current,
}: PolicyInputs & { current?: { number: number } }): Promise<AssociatedPullRequestTitle[]> => {
  const result: AssociatedPullRequestTitle[] = [];

  for (const pullRequest of pullRequests) {
    if (!needsTitleTypePolicy(pullRequest, current?.number)) {
      result.push(pullRequest);
      continue;
    }

    const inputs = await gateway.getTitleTypeInputs(
      {
        ...coordinates,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha,
        baseSha: pullRequest.baseSha,
        changedFiles: pullRequest.changedFiles,
      },
      signal
    );
    const typePolicy = titleTypePolicy(inputs);
    result.push({ ...pullRequest, typePolicy });
  }

  return result;
};

export const loadCurrentTitleTypePolicies = async ({
  gateway,
  coordinates,
  current,
  pullRequests,
  signal,
}: PolicyInputs & {
  coordinates: { owner: string; repo: string; pullRequestNumber: number };
  current: PullRequestTitleState;
}): Promise<{ current: PullRequestTitleState; pullRequests: AssociatedPullRequestTitle[] }> => {
  const enriched = await loadAssociatedTitleTypePolicies({
    gateway,
    coordinates,
    pullRequests,
    signal,
    current: { number: coordinates.pullRequestNumber },
  });
  const typePolicy = enriched.find((pullRequest) => pullRequest.number === coordinates.pullRequestNumber)?.typePolicy;

  return { current: { ...current, typePolicy }, pullRequests: enriched };
};
