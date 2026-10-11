import { composeDependencyGraph } from "./shared.js";

import type { Env } from "../env.js";
import type { GitHubWebhookDependencies } from "../handler/github/webhook.js";

export const composeGitHubWebhookDependencies = (env: Env["Bindings"]): GitHubWebhookDependencies => {
  const graph = composeDependencyGraph(env);

  return {
    autoApproveUsecase: graph.autoApproveUsecase,
    repositoryAdminUsecase: graph.repositoryAdminUsecase,
  };
};
