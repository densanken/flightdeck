import type {
  MergeCooldown,
  MergeCooldownStore,
  CachedInstallationRepositoryList,
  InstallationRepositoryCacheStore,
  RepoIndexCacheStore,
  SyncCooldown,
  SyncCooldownStore,
} from "./interface.js";
import type { RepositoryIndex } from "../../domain/repository.js";

export class MockMergeCooldownStore implements MergeCooldownStore {
  private readonly store = new Map<string, MergeCooldown>();

  private key(repoId: string, prNumber: number): string {
    return `${repoId}/${String(prNumber)}`;
  }

  get(repoId: string, prNumber: number): Promise<MergeCooldown | null> {
    return Promise.resolve(this.store.get(this.key(repoId, prNumber)) ?? null);
  }

  set(repoId: string, prNumber: number, data: MergeCooldown): Promise<void> {
    this.store.set(this.key(repoId, prNumber), data);
    return Promise.resolve();
  }

  delete(repoId: string, prNumber: number): Promise<void> {
    this.store.delete(this.key(repoId, prNumber));
    return Promise.resolve();
  }

  clear(): void {
    this.store.clear();
  }
}

export class MockSyncCooldownStore implements SyncCooldownStore {
  private readonly store = new Map<string, SyncCooldown>();

  get(repoId: string): Promise<SyncCooldown | null> {
    return Promise.resolve(this.store.get(repoId) ?? null);
  }

  set(repoId: string, data: SyncCooldown): Promise<void> {
    this.store.set(repoId, data);
    return Promise.resolve();
  }

  delete(repoId: string): Promise<void> {
    this.store.delete(repoId);
    return Promise.resolve();
  }

  clear(): void {
    this.store.clear();
  }
}

export class MockRepoIndexCacheStore implements RepoIndexCacheStore {
  private value: RepositoryIndex | null = null;

  get(): Promise<RepositoryIndex | null> {
    return Promise.resolve(this.value);
  }

  set(data: RepositoryIndex): Promise<void> {
    this.value = data;
    return Promise.resolve();
  }

  invalidate(): Promise<void> {
    this.value = null;
    return Promise.resolve();
  }

  clear(): void {
    this.value = null;
  }
}

export class MockInstallationRepositoryCacheStore implements InstallationRepositoryCacheStore {
  private value: CachedInstallationRepositoryList | null = null;

  get(): Promise<CachedInstallationRepositoryList | null> {
    return Promise.resolve(this.value);
  }

  set(data: CachedInstallationRepositoryList): Promise<void> {
    this.value = data;
    return Promise.resolve();
  }

  clear(): void {
    this.value = null;
  }
}
