import { loadPullRequestFiles, resolvePullRequestFiles } from "./pull-request-files.js";
import { TitleInputBudgetExceededError } from "./title-input-request.js";
import { readTitleTypeRulesFromBase } from "./title-type-config.js";

import type { TitleInputRequest } from "./title-input-request.js";
import type { TitleTypeInputs, TitleTypeRule } from "../../domain/title-types.js";
import type { TitleTypeInputsQuery } from "../../usecase/title-validation/dependencies.js";

export interface TitleTypeInputCache {
  rules: Map<string, Promise<TitleTypeRule[] | undefined>>;
  files: Map<string, Promise<Pick<TitleTypeInputs, "files" | "filesComplete">>>;
  fallbacks: Set<string>;
}

export const createTitleTypeInputCache = (): TitleTypeInputCache => ({
  rules: new Map(),
  files: new Map(),
  fallbacks: new Set(),
});

interface Input extends TitleInputRequest {
  cache: TitleTypeInputCache;
}

const cached = async <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
  }

  try {
    return await pending;
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
};

const snapshotKey = (input: TitleTypeInputsQuery): string =>
  JSON.stringify([input.owner, input.repo, input.pullRequestNumber, input.headSha, input.baseSha, input.changedFiles]);

export const getTitleTypeInputs = async (input: Input): Promise<TitleTypeInputs> => {
  const key = snapshotKey(input);
  const fallback: TitleTypeInputs = { rules: undefined, files: [], filesComplete: false };
  if (input.cache.fallbacks.has(key)) return fallback;

  try {
    return await loadTitleTypeInputs(input);
  } catch (error) {
    if (error instanceof TitleInputBudgetExceededError) {
      input.cache.fallbacks.add(key);
      return fallback;
    }

    throw error;
  }
};

const loadTitleTypeInputs = async (input: Input): Promise<TitleTypeInputs> => {
  const resolved = await resolvePullRequestFiles(input);
  const { baseSha } = resolved;

  const rules = await cached(input.cache.rules, `${input.owner}/${input.repo}:${baseSha}`, () =>
    readTitleTypeRulesFromBase(resolved)
  );

  if (!rules || rules.length === 0) return { rules, files: [], filesComplete: false };

  const result = await cached(input.cache.files, snapshotKey(resolved), () => loadPullRequestFiles(resolved));

  return { rules, ...result };
};
