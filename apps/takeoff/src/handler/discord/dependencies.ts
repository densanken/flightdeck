import type { MergeUsecase } from "../../usecase/merge/interface.js";
import type { PullRequestUsecase } from "../../usecase/pull-request/interface.js";
import type { RepositoryAdminUsecase } from "../../usecase/repository-admin/interface.js";
import type { StatusUsecase } from "../../usecase/status/interface.js";
import type { SyncUsecase } from "../../usecase/sync/interface.js";

export interface DiscordDependencies {
  pullRequestUsecase: PullRequestUsecase;
  mergeUsecase: MergeUsecase;
  statusUsecase: StatusUsecase;
  repositoryAdminUsecase: RepositoryAdminUsecase;
  syncUsecase: SyncUsecase;
}
