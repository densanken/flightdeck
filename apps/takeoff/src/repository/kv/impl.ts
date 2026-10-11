import { z } from "zod";

import { registeredRepositorySchema, repositoryIndexItemSchema } from "../../domain/repository.js";

import type { RegisteredRepositorySnapshot, RegisteredRepositoryStore } from "./interface.js";
import type { RegisteredRepository, RepositoryIndex, RepositoryIndexItem } from "../../domain/repository.js";

const REPOSITORY_KEY_PREFIX = "repo:";
const REPOSITORY_LIST_PAGE_SIZE = 1000;
const KV_BULK_GET_SIZE = 100;
const repositorySnapshotSchema = registeredRepositorySchema.extend({
  registrationId: z.string(),
});
const repositoryListMetadataSchema = repositoryIndexItemSchema.extend({
  registrationId: z.string(),
});

const repositoryKey = (repoId: string): string => `${REPOSITORY_KEY_PREFIX}${repoId}`;
const metadataKey = (repoId: string, registrationId: string): string => `repo-metadata:${repoId}:${registrationId}`;

const toIndexItem = (repo: RepositoryIndexItem): RepositoryIndexItem => ({
  repoId: repo.repoId,
  owner: repo.owner,
  name: repo.name,
  fullName: repo.fullName,
  htmlUrl: repo.htmlUrl,
});

const invalidRepositoryData = (): Error => new Error("Invalid registered repository data in KV");

const parseRepository = (value: unknown, expectedRepoId: string): RegisteredRepositorySnapshot => {
  const parsed = repositorySnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.repoId !== expectedRepoId) throw invalidRepositoryData();
  return parsed.data;
};

const parseIndexMetadata = (value: unknown, expectedRepoId: string) => {
  const parsed = repositoryListMetadataSchema.safeParse(value);
  if (!parsed.success || parsed.data.repoId !== expectedRepoId) throw invalidRepositoryData();
  return parsed.data;
};

const parseMetadata = (value: unknown, repoId: string, registrationId: string): RegisteredRepositorySnapshot | null => {
  if (value === null) return null;
  const metadata = parseRepository(value, repoId);
  return metadata.registrationId === registrationId ? metadata : null;
};

const repoIdFromKey = (key: string): string => {
  const repoId = key.slice(REPOSITORY_KEY_PREFIX.length);
  if (!repoId || repositoryKey(repoId) !== key) throw invalidRepositoryData();
  return repoId;
};

const sortIndexItems = (items: RepositoryIndexItem[]): RepositoryIndexItem[] =>
  items.sort((left, right) => left.repoId.localeCompare(right.repoId));

export class KvRegisteredRepositoryStore implements RegisteredRepositoryStore {
  constructor(private readonly kv: KVNamespace) {}

  async getRepository(repoId: string): Promise<RegisteredRepositorySnapshot | null> {
    const value = await this.kv.get(repositoryKey(repoId), "json");
    if (value === null) return null;
    const registered = parseRepository(value, repoId);
    return (await this.getMetadata(repoId, registered.registrationId)) ?? registered;
  }

  async getRepositoryIndex(): Promise<RepositoryIndex> {
    const itemsByRepoId = new Map<string, RepositoryIndexItem>();
    let cursor: string | undefined;

    for (;;) {
      const page = await this.kv.list({
        prefix: REPOSITORY_KEY_PREFIX,
        limit: REPOSITORY_LIST_PAGE_SIZE,
        cursor,
      });

      const registrations = page.keys.map((key) => {
        const repoId = repoIdFromKey(key.name);
        return parseIndexMetadata(key.metadata, repoId);
      });
      const metadataValues = await this.getManyJson(
        registrations.map((repo) => metadataKey(repo.repoId, repo.registrationId))
      );
      for (const item of registrations) {
        const metadata = parseMetadata(
          metadataValues.get(metadataKey(item.repoId, item.registrationId)),
          item.repoId,
          item.registrationId
        );
        itemsByRepoId.set(item.repoId, toIndexItem(metadata ?? item));
      }

      if (page.list_complete) break;
      if (!page.cursor || page.cursor === cursor) {
        throw new Error("Invalid KV list cursor while rebuilding repository index");
      }
      cursor = page.cursor;
    }

    return {
      items: sortIndexItems([...itemsByRepoId.values()]),
      updatedAt: new Date().toISOString(),
    };
  }

  async addRepository(repo: RegisteredRepository): Promise<RepositoryIndex> {
    const indexItem = toIndexItem(repo);
    const registered = { ...repo, registrationId: crypto.randomUUID() };
    await this.kv.put(repositoryKey(repo.repoId), JSON.stringify(registered), {
      metadata: { ...indexItem, registrationId: registered.registrationId },
    });

    const index = await this.getRepositoryIndex();
    return {
      items: sortIndexItems([...index.items.filter((item) => item.repoId !== repo.repoId), indexItem]),
      updatedAt: new Date().toISOString(),
    };
  }

  updateRepositoryMetadata(repo: RegisteredRepositorySnapshot): Promise<void> {
    // remove より後に完了しても登録 intent を復活させず、再登録には世代不一致で適用しない
    return this.kv.put(metadataKey(repo.repoId, repo.registrationId), JSON.stringify(repo));
  }

  async removeRepository(repoId: string): Promise<RepositoryIndex | null> {
    const repo = await this.getRepository(repoId);
    if (!repo) return null;

    await this.kv.delete(repositoryKey(repoId));
    try {
      await this.kv.delete(metadataKey(repoId, repo.registrationId));
    } catch (error) {
      // 登録 intent は削除済みなので、孤立 metadata の掃除失敗で index 更新を止めない
      console.error("repository_metadata_delete_failed", {
        repoId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    const index = await this.getRepositoryIndex();
    return {
      items: index.items.filter((item) => item.repoId !== repoId),
      updatedAt: new Date().toISOString(),
    };
  }

  private async getMetadata(repoId: string, registrationId: string): Promise<RegisteredRepositorySnapshot | null> {
    const value = await this.kv.get(metadataKey(repoId, registrationId), "json");
    return parseMetadata(value, repoId, registrationId);
  }

  private async getManyJson(keys: string[]): Promise<Map<string, unknown>> {
    const values = new Map<string, unknown>();
    // bulk get は 1 operation 扱いなので、index 全走査で invocation 上限を使い切らない
    for (let offset = 0; offset < keys.length; offset += KV_BULK_GET_SIZE) {
      const chunk = await this.kv.get(keys.slice(offset, offset + KV_BULK_GET_SIZE), "json");
      for (const [key, value] of chunk) values.set(key, value);
    }
    return values;
  }
}
