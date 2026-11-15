import { normalizeGitHubUrl } from "@flightdeck/rules";

import { DispatchError } from "../errors.js";

// GitHub が .gitmodules から読み取った submodule
// url は GitHub の gitUrl
export interface Submodule {
  path: string;
  url: string;
  // path の gitlink の SHA
  // gitlink でなければ undefined
  commitSha: string | undefined;
}

export const findSubmodule = (submodules: Submodule[], source: string, parent: string): Submodule => {
  const matches = submodules.filter((submodule) => normalizeGitHubUrl(submodule.url) === source.toLowerCase());
  const match = matches[0];
  if (matches.length !== 1 || match === undefined)
    throw new DispatchError("config", `.gitmodules must contain exactly one submodule for ${source}: ${parent}`);

  return match;
};
