import { truncateChoiceName } from "../discord-choice.js";
import { autocompleteResponse } from "../interaction-response.js";
import { INSTALLATION_REPOSITORIES_KEY, REPOSITORY_INDEX_KEY } from "../single-flight.js";
import { createTimeoutBudget, LOADING_VALUE, REPOSITORY_LIST_LOADING_MESSAGE } from "../timeout-budget.js";
import { loadCached } from "./cached-load.js";
import { parseGitHubRepoUrl } from "./parse-github-url.js";
import { errorDetail } from "../../../util/error-detail.js";
import { logger } from "../../../util/logger.js";

import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { Context } from "hono";

const loadingResponse = (c: Context<Env>): Response =>
  c.json(autocompleteResponse([{ name: REPOSITORY_LIST_LOADING_MESSAGE, value: LOADING_VALUE }]));

export const handleRepoAddAutocomplete = async (
  c: Context<Env>,
  focusedValue: string,
  deps: DiscordDependencies
): Promise<Response> => {
  // 2 段の読み込みが独立した制限時間を持つと合計で 3 秒を超えるため、request 全体で deadline を共有する
  const budget = createTimeoutBudget();

  try {
    const installationRepositories = await loadCached(c, budget, {
      label: INSTALLATION_REPOSITORIES_KEY,
      readCache: () => deps.repositoryAdminUsecase.getCachedInstallationRepositories(),
      load: () => deps.repositoryAdminUsecase.getInstallationRepositories(),
    });
    if (installationRepositories.status === "loading") {
      return loadingResponse(c);
    }

    // 登録済みリポジトリの除外は cache hit を優先し、KV の全件 list へ落ちる場合も残り時間に収める
    const index = await loadCached(c, budget, {
      label: REPOSITORY_INDEX_KEY,
      readCache: () => deps.repositoryAdminUsecase.getCachedRepositoryIndex(),
      load: () => deps.repositoryAdminUsecase.getRepositoryIndex(),
    });
    if (index.status === "loading") {
      return loadingResponse(c);
    }

    // 名前は rename や大文字小文字の違いで cache 間の表記がずれうるため、登録済みの判定は repository ID で行う
    const registeredIds = new Set(index.value.items.map((item) => item.repoId));
    // GitHub の login は大文字小文字を区別しないため、設定値と表記が違っても同じ org として扱う
    const org = c.env.GITHUB_ORG.toLowerCase();
    const parsed = parseGitHubRepoUrl(focusedValue);
    const choices = installationRepositories.value.items
      .filter((repository) => repository.owner.toLowerCase() === org)
      .filter((repository) => !registeredIds.has(String(repository.id)))
      .filter((repository) => {
        if (parsed) {
          const fullName = `${parsed.owner}/${parsed.repo}`.toLowerCase();
          return repository.fullName.toLowerCase().startsWith(fullName);
        }
        const query = focusedValue.toLowerCase();
        return (
          !query || repository.fullName.toLowerCase().includes(query) || repository.name.toLowerCase().includes(query)
        );
      })
      .slice(0, 25)
      // owner は org に絞り込み済みなので、value は 100 文字の上限に必ず収まる repository 名だけにする
      // owner を含めると、GitHub が許す 100 文字の repository 名で上限を超える
      .map((repository) => ({
        name: truncateChoiceName(repository.fullName),
        value: repository.name,
      }));

    return c.json(autocompleteResponse(choices));
  } catch (error) {
    // 空候補は利用者から障害と区別できないため、運用側が検知できるよう記録する
    logger.log("error", { event: "discord_autocomplete_failed", label: "repo_add", error: errorDetail(error) });
    return c.json(autocompleteResponse([]));
  }
};
