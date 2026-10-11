import type { RegisteredRepository, RepositoryIndex } from "../../domain/repository.js";
import type { CachedInstallationRepositoryList } from "../../repository/cache/interface.js";

export type RepositoryReconcileResult =
  { type: "not_registered" } | { type: "synchronized"; repository: RegisteredRepository } | { type: "removed" };

// repository 登録・削除のフロー（GitHub 照会 → KV 永続化 → index cache 更新 → PR cache 整備）
// 入力検証・権限確認・表示変換は handler に残す
export interface RepositoryAdminUsecase {
  // owner / name は handler で形式・org 検証済みの値を受け取る
  addRepository(owner: string, name: string): Promise<RegisteredRepository>;
  removeRepository(repoId: string): Promise<boolean>;
  getRepository(repoId: string): Promise<RegisteredRepository | null>;
  reconcileRepository(repoId: string, githubOrg: string): Promise<RepositoryReconcileResult>;
  getRepositoryIndex(): Promise<RepositoryIndex>;
  getCachedRepositoryIndex(): Promise<RepositoryIndex | null>;
  // GitHub App の installation から取得し、cache を書き換える
  getInstallationRepositories(): Promise<CachedInstallationRepositoryList>;
  getCachedInstallationRepositories(): Promise<CachedInstallationRepositoryList | null>;
}
