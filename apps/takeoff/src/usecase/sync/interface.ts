import type { CachedPullRequestList } from "../../domain/pull-request.js";
import type { RegisteredRepository } from "../../domain/repository.js";

// PR 一覧 cache の強制更新フロー（cooldown 判定 → warming → 失敗時の cooldown 解除）
export interface SyncUsecase {
  sync(repo: RegisteredRepository, discordUserId: string): Promise<CachedPullRequestList>;
}
