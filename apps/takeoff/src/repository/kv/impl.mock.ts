import type { RegisteredRepositorySnapshot, RegisteredRepositoryStore } from "./interface.js";
import type { RegisteredRepository, RepositoryIndex, RepositoryIndexItem } from "../../domain/repository.js";

export class MockRegisteredRepositoryStore implements RegisteredRepositoryStore {
  private repos = new Map<string, RegisteredRepositorySnapshot>();

  getRepository(repoId: string): Promise<RegisteredRepositorySnapshot | null> {
    return Promise.resolve(this.repos.get(repoId) ?? null);
  }

  getRepositoryIndex(): Promise<RepositoryIndex> {
    const items: RepositoryIndexItem[] = Array.from(this.repos.values()).map((repo) => ({
      repoId: repo.repoId,
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
    }));
    return Promise.resolve({
      items,
      updatedAt: new Date().toISOString(),
    });
  }

  addRepository(repo: RegisteredRepository): Promise<RepositoryIndex> {
    this.repos.set(repo.repoId, { ...repo, registrationId: crypto.randomUUID() });
    return this.getRepositoryIndex();
  }

  updateRepositoryMetadata(repo: RegisteredRepositorySnapshot): Promise<void> {
    const registered = this.repos.get(repo.repoId);
    if (registered?.registrationId === repo.registrationId) this.repos.set(repo.repoId, repo);
    return Promise.resolve();
  }

  removeRepository(repoId: string): Promise<RepositoryIndex | null> {
    const repo = this.repos.get(repoId);
    if (!repo) return Promise.resolve(null);

    this.repos.delete(repoId);

    return this.getRepositoryIndex();
  }
}
