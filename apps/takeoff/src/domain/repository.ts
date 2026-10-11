import { z } from "zod";

export interface RegisteredRepository {
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryIndexItem {
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
}

export interface RepositoryIndex {
  items: RepositoryIndexItem[];
  updatedAt: string;
}

// Cache API から読み戻した repo-index を検証するための schema
// 別 isolate や過去バージョンが書いた不正な shape を miss として弾く
export const repositoryIndexItemSchema = z.object({
  repoId: z.string(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  htmlUrl: z.string(),
}) satisfies z.ZodType<RepositoryIndexItem>;

export const repositoryIndexSchema = z.object({
  items: z.array(repositoryIndexItemSchema),
  updatedAt: z.string(),
}) satisfies z.ZodType<RepositoryIndex>;

export const registeredRepositorySchema = repositoryIndexItemSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<RegisteredRepository>;
