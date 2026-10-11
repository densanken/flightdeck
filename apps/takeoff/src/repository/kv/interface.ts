import type { RegisteredRepository, RepositoryIndex } from "../../domain/repository.js";

export interface RegisteredRepositorySnapshot extends RegisteredRepository {
  registrationId: string;
}

export interface RegisteredRepositoryStore {
  getRepository(repoId: string): Promise<RegisteredRepositorySnapshot | null>;
  // repo: prefix の個別 key を cursor pagination で列挙し、毎回 index を再構築する
  getRepositoryIndex(): Promise<RepositoryIndex>;
  // 変更後の index を返す
  // KV list が一時的に古くても、追加対象は必ず返り値へ含める
  addRepository(repo: RegisteredRepository): Promise<RepositoryIndex>;
  // 読取時の登録世代に対する metadata だけを更新し、登録 intent は作成しない
  updateRepositoryMetadata(repo: RegisteredRepositorySnapshot): Promise<void>;
  // 変更後の index を返す
  // 削除対象が無い場合は null
  removeRepository(repoId: string): Promise<RepositoryIndex | null>;
}
