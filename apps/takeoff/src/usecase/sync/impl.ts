import { errors } from "../../domain/errors.js";
import { nowIso } from "../../domain/time.js";
import { errorDetail } from "../../util/error-detail.js";

import type { SyncUsecase } from "./interface.js";
import type { CachedPullRequestList } from "../../domain/pull-request.js";
import type { RegisteredRepository } from "../../domain/repository.js";
import type { SyncCooldownStore } from "../../repository/cache/interface.js";
import type { InstallationTokenProvider } from "../github.js";
import type { PullRequestUsecase } from "../pull-request/interface.js";

export class SyncUsecaseImpl implements SyncUsecase {
  constructor(
    private readonly tokenProvider: InstallationTokenProvider,
    private readonly syncCooldownCache: SyncCooldownStore,
    private readonly pullRequestUsecase: PullRequestUsecase
  ) {}

  async sync(repo: RegisteredRepository, discordUserId: string): Promise<CachedPullRequestList> {
    // cooldown は colo-local Cache API の best-effort 負荷抑止であり、別 colo や同時 miss の重複実行は許容する
    if (await this.syncCooldownCache.get(repo.repoId)) {
      throw errors.syncCooldown();
    }

    await this.syncCooldownCache.set(repo.repoId, {
      repoId: repo.repoId,
      requestedAt: nowIso(),
      requestedByDiscordUserId: discordUserId,
    });

    try {
      const token = await this.tokenProvider.getToken();
      return await this.pullRequestUsecase.warmPullRequestListCache(token, repo.owner, repo.name, repo.repoId);
    } catch (error) {
      // warming に失敗したら cooldown を解除し、すぐ再試行できるようにする
      await this.syncCooldownCache.delete(repo.repoId).catch((deleteError: unknown) => {
        console.error("sync_cooldown_clear_failed", { repoId: repo.repoId, error: errorDetail(deleteError) });
      });
      throw error;
    }
  }
}
