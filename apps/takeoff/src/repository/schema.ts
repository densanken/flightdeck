import { repositoryFullName } from "@flightdeck/validation";
import * as v from "valibot";

// 別 isolate や過去バージョンが書いた不正な repo-index は cache miss として扱う
export const repositoryIndexItemSchema = v.object({
  repoId: v.string(),
  owner: v.string(),
  name: v.string(),
  fullName: repositoryFullName,
  htmlUrl: v.string(),
});

export const repositoryIndexSchema = v.object({ items: v.array(repositoryIndexItemSchema), updatedAt: v.string() });

export const registeredRepositorySchema = v.object({
  ...repositoryIndexItemSchema.entries,
  createdAt: v.string(),
  updatedAt: v.string(),
});
