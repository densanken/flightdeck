import { truncateChoiceName } from "../discord-choice.js";
import { autocompleteResponse } from "../interaction-response.js";
import { REPOSITORY_INDEX_KEY } from "../single-flight.js";
import { createTimeoutBudget, LOADING_VALUE, REPOSITORY_LIST_LOADING_MESSAGE } from "../timeout-budget.js";
import { loadCached } from "./cached-load.js";
import { parseGitHubRepoUrl } from "./parse-github-url.js";
import { errorDetail } from "../../../util/error-detail.js";

import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { Context } from "hono";

export const handleRepoAutocomplete = async (
  c: Context<Env>,
  focusedValue: string,
  deps: DiscordDependencies
): Promise<Response> => {
  // cache 読み出しを含めて request 全体で 1 つの deadline を共有する
  const budget = createTimeoutBudget();

  try {
    // cache hit なら同期で返し、miss のときだけ KV の全件 list を残り時間で実行する
    const loaded = await loadCached(c, budget, {
      label: REPOSITORY_INDEX_KEY,
      readCache: () => deps.repositoryAdminUsecase.getCachedRepositoryIndex(),
      load: () => deps.repositoryAdminUsecase.getRepositoryIndex(),
    });
    if (loaded.status === "loading") {
      return c.json(autocompleteResponse([{ name: REPOSITORY_LIST_LOADING_MESSAGE, value: LOADING_VALUE }]));
    }
    const index = loaded.value;

    const parsed = parseGitHubRepoUrl(focusedValue);
    const filtered = parsed
      ? index.items.filter((item) => {
          const fullName = `${parsed.owner}/${parsed.repo}`.toLowerCase();
          return item.fullName.toLowerCase().startsWith(fullName);
        })
      : index.items.filter((item) => {
          const q = focusedValue.toLowerCase();
          return !q || item.fullName.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
        });

    const choices = filtered.slice(0, 25).map((item) => ({
      name: truncateChoiceName(item.fullName),
      value: item.repoId,
    }));

    return c.json(autocompleteResponse(choices));
  } catch (error) {
    // 空候補は利用者から障害と区別できないため、運用側が検知できるよう記録する
    console.error("discord_autocomplete_failed", { label: "repo", error: errorDetail(error) });
    return c.json(autocompleteResponse([]));
  }
};
