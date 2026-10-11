import { composeDependencyGraph } from "./shared.js";

import type { Env } from "../env.js";
import type { DiscordDependencies } from "../handler/discord/dependencies.js";

export const composeDiscordDependencies = (env: Env["Bindings"]): DiscordDependencies => {
  const graph = composeDependencyGraph(env);

  return {
    pullRequestUsecase: graph.pullRequestUsecase,
    mergeUsecase: graph.mergeUsecase,
    statusUsecase: graph.statusUsecase,
    repositoryAdminUsecase: graph.repositoryAdminUsecase,
    syncUsecase: graph.syncUsecase,
  };
};
