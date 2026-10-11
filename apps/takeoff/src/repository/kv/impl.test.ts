/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KvRegisteredRepositoryStore } from "./impl.js";

import type { RegisteredRepository, RepositoryIndexItem } from "../../domain/repository.js";

interface TestEntry {
  value: unknown;
  metadata: unknown;
}

class TestKv {
  readonly entries = new Map<string, TestEntry>();
  operations = 0;

  readonly get = vi.fn((key: string | string[]): Promise<unknown> => {
    this.countOperation();
    if (Array.isArray(key)) {
      if (key.length > 100) return Promise.reject(new Error("KV bulk get key limit exceeded"));
      return Promise.resolve(new Map(key.map((item) => [item, this.entries.get(item)?.value ?? null])));
    }
    return Promise.resolve(this.entries.get(key)?.value ?? null);
  });

  readonly put = vi.fn((key: string, value: string, options?: unknown): Promise<void> => {
    this.countOperation();
    const metadata =
      typeof options === "object" && options !== null && "metadata" in options ? options.metadata : undefined;
    this.entries.set(key, { value: JSON.parse(value) as unknown, metadata });
    return Promise.resolve();
  });

  readonly delete = vi.fn((key: string): Promise<void> => {
    this.countOperation();
    this.entries.delete(key);
    return Promise.resolve();
  });

  readonly list = vi.fn((options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<unknown>> => {
    this.countOperation();
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const start = Number.parseInt(options?.cursor ?? "0", 10);
    const names = [...this.entries.keys()].filter((name) => name.startsWith(prefix)).sort();
    const pageNames = names.slice(start, start + limit);
    const keys = pageNames.map((name) => ({ name, metadata: this.entries.get(name)?.metadata }));
    const next = start + pageNames.length;
    if (next < names.length) {
      return Promise.resolve({ list_complete: false, keys, cursor: String(next), cacheStatus: null });
    }
    return Promise.resolve({ list_complete: true, keys, cacheStatus: null });
  });

  seed(key: string, value: unknown, metadata?: unknown): void {
    this.entries.set(key, { value, metadata });
  }

  seedRepository(repo: RegisteredRepository): void {
    const registrationId = `registration-${repo.repoId}`;
    this.seed(`repo:${repo.repoId}`, { ...repo, registrationId }, { ...toMetadata(repo), registrationId });
  }

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }

  private countOperation(): void {
    this.operations += 1;
    if (this.operations > 1000) throw new Error("KV invocation operation limit exceeded");
  }
}

const makeRepo = (id: string, name: string): RegisteredRepository => ({
  repoId: id,
  owner: "test-org",
  name,
  fullName: `test-org/${name}`,
  htmlUrl: `https://github.com/test-org/${name}`,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
});

const toMetadata = (repo: RegisteredRepository): RepositoryIndexItem => ({
  repoId: repo.repoId,
  owner: repo.owner,
  name: repo.name,
  fullName: repo.fullName,
  htmlUrl: repo.htmlUrl,
});

describe("KvRegisteredRepositoryStore", () => {
  let kv: TestKv;
  let repoStore: KvRegisteredRepositoryStore;

  beforeEach(() => {
    kv = new TestKv();
    repoStore = new KvRegisteredRepositoryStore(kv.namespace());
  });

  it("存在しない repo は null を返す", async () => {
    await expect(repoStore.getRepository("999")).resolves.toBeNull();
  });

  it("repository を個別 key と metadata へ保存し、集約 key は書かない", async () => {
    const repo = makeRepo("123", "my-repo");

    const index = await repoStore.addRepository(repo);

    await expect(repoStore.getRepository("123")).resolves.toMatchObject(repo);
    expect(kv.entries.get("repo:123")?.metadata).toMatchObject(toMetadata(repo));
    expect(kv.entries.get("repo:123")?.metadata).toHaveProperty(
      "registrationId",
      (await repoStore.getRepository("123"))?.registrationId
    );
    expect(kv.entries.has("repo-index")).toBe(false);
    expect(index.items).toEqual([toMetadata(repo)]);
  });

  it("index は list metadata の登録世代から metadata だけを bulk get する", async () => {
    const repo = makeRepo("123", "my-repo");
    kv.seedRepository(repo);

    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [toMetadata(repo)] });

    expect(kv.get).toHaveBeenCalledExactlyOnceWith(["repo-metadata:123:registration-123"], "json");
  });

  it.each([
    [1000, 1],
    [1001, 2],
  ])("1000 件境界の $count 件を cursor pagination で再構築する", async (count, expectedPageCount) => {
    for (let index = 0; index < count; index += 1) {
      const repo = makeRepo(String(index).padStart(4, "0"), `repo-${String(index)}`);
      kv.seedRepository(repo);
    }

    const result = await repoStore.getRepositoryIndex();

    expect(result.items).toHaveLength(count);
    expect(kv.list).toHaveBeenCalledTimes(expectedPageCount);
    expect(kv.list.mock.calls[0]?.[0]).toMatchObject({ limit: 1000, cursor: undefined });
    if (count > 1000) {
      expect(kv.list.mock.calls[1]?.[0]).toMatchObject({ limit: 1000, cursor: "1000" });
    }
  });

  it.each([
    [1000, 11],
    [1001, 13],
  ])("%i 件を KV invocation 上限内の %i operations で metadata と結合する", async (count, expectedOperations) => {
    for (let index = 0; index < count; index += 1) {
      const repo = makeRepo(String(index).padStart(4, "0"), `repo-${String(index)}`);
      const registrationId = `registration-${String(index)}`;
      const registered = { ...repo, registrationId };
      kv.seed(`repo:${repo.repoId}`, registered, { ...toMetadata(repo), registrationId });
      const renamed = { ...registered, ...toMetadata(makeRepo(repo.repoId, `renamed-${String(index)}`)) };
      kv.seed(`repo-metadata:${repo.repoId}:${registrationId}`, renamed);
    }

    const index = await repoStore.getRepositoryIndex();

    expect(index.items).toHaveLength(count);
    expect(index.items.every((item) => item.name.startsWith("renamed-"))).toBe(true);
    expect(kv.operations).toBe(expectedOperations);
    expect(kv.get.mock.calls.every(([keys]) => Array.isArray(keys) && keys.length <= 100)).toBe(true);
  });

  it("bulk get の失敗は部分的な index へ変換しない", async () => {
    const repo = makeRepo("123", "repo");
    kv.seedRepository(repo);
    kv.get.mockRejectedValueOnce(new Error("bulk read failed"));

    await expect(repoStore.getRepositoryIndex()).rejects.toThrow("bulk read failed");
  });

  it("空 page でも cursor が進む限り次 page を読む", async () => {
    const repo = makeRepo("123", "after-empty-page");
    kv.seedRepository(repo);
    kv.list.mockResolvedValueOnce({ list_complete: false, keys: [], cursor: "0", cacheStatus: null });

    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [toMetadata(repo)] });
    expect(kv.list).toHaveBeenCalledTimes(2);
  });

  it("cursor が進まない不正な list response は fail-closed にする", async () => {
    kv.list
      .mockResolvedValueOnce({ list_complete: false, keys: [], cursor: "same", cacheStatus: null })
      .mockResolvedValueOnce({ list_complete: false, keys: [], cursor: "same", cacheStatus: null });

    await expect(repoStore.getRepositoryIndex()).rejects.toThrow("Invalid KV list cursor");
  });

  it.each([
    ["欠落した", undefined],
    ["shape が不正な", { repoId: "123" }],
    ["key と repoId が不一致な", { ...toMetadata(makeRepo("456", "wrong-id")), registrationId: "registration-456" }],
  ])("%s metadata は fail-closed にする", async (_caseName, metadata) => {
    kv.seed("repo:123", makeRepo("123", "repo"), metadata);

    await expect(repoStore.getRepositoryIndex()).rejects.toThrow("Invalid registered repository data");
  });

  it("list failure は空 index へ変換せず fail-closed にする", async () => {
    kv.list.mockRejectedValueOnce(new Error("list failed"));

    await expect(repoStore.getRepositoryIndex()).rejects.toThrow("list failed");
  });

  it("個別 repository の get failure も未登録扱いにせず fail-closed にする", async () => {
    kv.get.mockRejectedValueOnce(new Error("get failed"));

    await expect(repoStore.getRepository("123")).rejects.toThrow("get failed");
  });

  it("addRepository は stale list にない追加対象を変更後 index へ含める", async () => {
    kv.list.mockResolvedValueOnce({ list_complete: true, keys: [], cacheStatus: null });

    const added = await repoStore.addRepository(makeRepo("123", "new-repo"));

    expect(added.items.map((item) => item.repoId)).toEqual(["123"]);
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({
      items: [expect.objectContaining({ repoId: "123" })],
    });
  });

  it("removeRepository は stale list に残る削除対象を変更後 index から除く", async () => {
    const repo = makeRepo("123", "removed-repo");
    kv.seedRepository(repo);
    kv.list.mockResolvedValueOnce({
      list_complete: true,
      keys: [{ name: "repo:123", metadata: kv.entries.get("repo:123")?.metadata }],
      cacheStatus: null,
    });

    const removed = await repoStore.removeRepository("123");

    expect(removed?.items).toEqual([]);
    await expect(repoStore.getRepository("123")).resolves.toBeNull();
  });

  it("存在しない repo の削除は null を返す", async () => {
    await expect(repoStore.removeRepository("999")).resolves.toBeNull();
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("並行add/addでも個別repo keyを失わず、明示再構築で両方へ収束する", async () => {
    await Promise.all([
      repoStore.addRepository(makeRepo("1", "repo-a")),
      repoStore.addRepository(makeRepo("2", "repo-b")),
    ]);

    expect(kv.entries.has("repo:1")).toBe(true);
    expect(kv.entries.has("repo:2")).toBe(true);
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({
      items: [expect.objectContaining({ repoId: "1" }), expect.objectContaining({ repoId: "2" })],
    });
  });

  it("並行add/removeでも別repositoryの個別keyを失わない", async () => {
    await repoStore.addRepository(makeRepo("1", "remove-me"));
    await repoStore.addRepository(makeRepo("2", "keep-me"));

    await Promise.all([repoStore.addRepository(makeRepo("3", "new-repo")), repoStore.removeRepository("1")]);

    expect(kv.entries.has("repo:1")).toBe(false);
    expect(kv.entries.has("repo:2")).toBe(true);
    expect(kv.entries.has("repo:3")).toBe(true);
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({
      items: [expect.objectContaining({ repoId: "2" }), expect.objectContaining({ repoId: "3" })],
    });
  });

  it("index再構築失敗時も追加済み個別keyを失わずretry可能にする", async () => {
    kv.list.mockRejectedValueOnce(new Error("temporary list failure"));

    await expect(repoStore.addRepository(makeRepo("123", "retryable"))).rejects.toThrow("temporary list failure");

    await expect(repoStore.getRepository("123")).resolves.toMatchObject({ repoId: "123" });
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({
      items: [expect.objectContaining({ repoId: "123" })],
    });
  });

  it("metadata 更新は登録 intent を変更せず get と index に同じ rename を反映する", async () => {
    await repoStore.addRepository(makeRepo("123", "before"));
    const registered = await repoStore.getRepository("123");
    if (!registered) throw new Error("Missing registered repository");
    const renamed = { ...registered, ...toMetadata(makeRepo("123", "after")) };
    kv.put.mockClear();

    await repoStore.updateRepositoryMetadata(renamed);

    expect(kv.put).toHaveBeenCalledExactlyOnceWith(
      `repo-metadata:123:${registered.registrationId}`,
      JSON.stringify(renamed)
    );
    expect(kv.entries.get("repo:123")?.value).toMatchObject({ name: "before" });
    await expect(repoStore.getRepository("123")).resolves.toEqual(renamed);
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [toMetadata(renamed)] });
  });

  it("metadata は登録世代が一致する場合だけ重ねる", async () => {
    kv.seedRepository(makeRepo("123", "before"));
    const registered = await repoStore.getRepository("123");
    if (!registered) throw new Error("Missing registered repository");
    const renamed = { ...registered, ...toMetadata(makeRepo("123", "after")) };

    await repoStore.updateRepositoryMetadata(renamed);
    await expect(repoStore.getRepository("123")).resolves.toEqual(renamed);
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [toMetadata(renamed)] });

    kv.seed(`repo-metadata:123:${registered.registrationId}`, { ...renamed, registrationId: "different-generation" });
    await expect(repoStore.getRepository("123")).resolves.toEqual(registered);
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [toMetadata(registered)] });
  });

  it.each(["before", "after"])("metadata 書込の %s に remove が完了しても登録を復活させない", async (timing) => {
    await repoStore.addRepository(makeRepo("123", "before"));
    const registered = await repoStore.getRepository("123");
    if (!registered) throw new Error("Missing registered repository");
    const renamed = { ...registered, ...toMetadata(makeRepo("123", "after")) };
    const put = kv.put.getMockImplementation();
    if (!put) throw new Error("Missing KV put implementation");
    kv.put.mockImplementationOnce(async (key, value, options) => {
      if (timing === "before") await repoStore.removeRepository("123");
      await put(key, value, options);
      if (timing === "after") await repoStore.removeRepository("123");
    });

    await repoStore.updateRepositoryMetadata(renamed);

    expect(kv.entries.has("repo:123")).toBe(false);
    await expect(repoStore.getRepository("123")).resolves.toBeNull();
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [] });
  });

  it("再登録後に古い reconcile の metadata が到着しても新しい世代の metadata を上書きしない", async () => {
    const repo = makeRepo("123", "registered-again");
    await repoStore.addRepository(repo);
    const previousRegistration = await repoStore.getRepository("123");
    if (!previousRegistration) throw new Error("Missing registered repository");
    await repoStore.removeRepository("123");
    await repoStore.addRepository(repo);
    const currentRegistration = await repoStore.getRepository("123");
    if (!currentRegistration) throw new Error("Missing registered repository");
    const currentMetadata = { ...currentRegistration, ...toMetadata(makeRepo("123", "new-rename")) };
    await repoStore.updateRepositoryMetadata(currentMetadata);

    await repoStore.updateRepositoryMetadata({
      ...previousRegistration,
      ...toMetadata(makeRepo("123", "stale-rename")),
    });

    await expect(repoStore.getRepository("123")).resolves.toEqual(currentMetadata);
    expect((await repoStore.getRepository("123"))?.registrationId).not.toEqual(previousRegistration.registrationId);
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({ items: [toMetadata(currentMetadata)] });
  });

  it("metadata cleanup の失敗では登録解除と変更後 index の構築を中断しない", async () => {
    await repoStore.addRepository(makeRepo("123", "remove-me"));
    kv.delete.mockImplementation((key) => {
      if (key.startsWith("repo-metadata:")) return Promise.reject(new Error("sensitive backend error"));
      kv.entries.delete(key);
      return Promise.resolve();
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(repoStore.removeRepository("123")).resolves.toMatchObject({ items: [] });

    await expect(repoStore.getRepository("123")).resolves.toBeNull();
    expect(log).toHaveBeenCalledExactlyOnceWith("repository_metadata_delete_failed", {
      repoId: "123",
      errorName: "Error",
    });
    log.mockRestore();
  });
});
