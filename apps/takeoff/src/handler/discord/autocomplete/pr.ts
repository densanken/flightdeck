import { truncateChoiceName } from "../discord-choice.js";
import { autocompleteResponse } from "../interaction-response.js";
import { once, pullRequestsKey, REPOSITORY_INDEX_KEY } from "../single-flight.js";
import {
  createTimeoutBudget,
  LOADING_VALUE,
  PULL_REQUESTS_LOADING_MESSAGE,
  REPOSITORY_LIST_LOADING_MESSAGE,
  warmInBackground,
} from "../timeout-budget.js";
import { loadCached } from "./cached-load.js";
import { parseGitHubPrUrl, parseGitHubRepoUrl } from "./parse-github-url.js";
import { errorDetail } from "../../../util/error-detail.js";

import type { CachedPullRequest } from "../../../domain/pull-request.js";
import type { Env } from "../../../env.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { Context } from "hono";

// Discord の autocomplete 候補は 25 件まで
const MAX_AUTOCOMPLETE_CHOICES = 25;

const filterPullRequests = (prs: CachedPullRequest[], query: string, exactNumber: boolean): CachedPullRequest[] => {
  const q = query.toLowerCase();
  if (!q) return prs.slice(0, MAX_AUTOCOMPLETE_CHOICES);

  // PR URL 由来の番号は特定の PR を指すため、title や login への部分一致で別番号を混ぜない
  if (exactNumber) {
    return prs.filter((pr) => String(pr.number) === query).slice(0, MAX_AUTOCOMPLETE_CHOICES);
  }

  return prs
    .filter(
      (pr) =>
        String(pr.number).includes(q) || pr.title.toLowerCase().includes(q) || pr.authorLogin.toLowerCase().includes(q)
    )
    .slice(0, MAX_AUTOCOMPLETE_CHOICES);
};

const formatPrChoiceName = (pr: CachedPullRequest): string => truncateChoiceName(`#${String(pr.number)} ${pr.title}`);

const repositoryLoadingResponse = (c: Context<Env>): Response =>
  c.json(autocompleteResponse([{ name: REPOSITORY_LIST_LOADING_MESSAGE, value: LOADING_VALUE }]));

export const handlePrAutocomplete = async (
  c: Context<Env>,
  repoId: string,
  focusedValue: string,
  deps: DiscordDependencies
): Promise<Response> => {
  // repo の候補が読み込み中のまま pr へ移動した場合、repoId は実値ではない
  // autocomplete では案内候補として返す
  if (repoId === LOADING_VALUE) return repositoryLoadingResponse(c);

  // cache 読み出しを含めて request 全体で 1 つの deadline を共有する
  const budget = createTimeoutBudget();

  try {
    // repository の解決は cache だけで行う
    // ここで KV の全件 list を待つと PR 一覧に使える時間が無くなる
    const cachedIndex = await budget.race(
      () => deps.repositoryAdminUsecase.getCachedRepositoryIndex(),
      `${REPOSITORY_INDEX_KEY}_cache`
    );
    if (cachedIndex.status === "loading" || cachedIndex.value === null) {
      // repo を貼り付けで直接入力した場合は repo の autocomplete が動かないため、
      // ここで温めないと index を温める経路が無く、読み込み中を返し続ける
      warmInBackground(
        c,
        REPOSITORY_INDEX_KEY,
        once(REPOSITORY_INDEX_KEY, () => deps.repositoryAdminUsecase.getRepositoryIndex())
      );
      return repositoryLoadingResponse(c);
    }
    const repo = cachedIndex.value.items.find((item) => item.repoId === repoId);
    if (!repo) return c.json(autocompleteResponse([]));

    // cache hit なら同期で返し、miss のときだけ token 取得と GitHub API を残り時間で実行する
    const loaded = await loadCached(c, budget, {
      label: "pull_requests",
      key: pullRequestsKey(repo.repoId),
      readCache: () => deps.pullRequestUsecase.getCachedPullRequestList(repo.repoId),
      load: () => deps.pullRequestUsecase.listOpenPullRequests(repo.owner, repo.name, repo.repoId),
    });
    if (loaded.status === "loading") {
      return c.json(autocompleteResponse([{ name: PULL_REQUESTS_LOADING_MESSAGE, value: LOADING_VALUE }]));
    }
    const prList = loaded.value;

    let filterQuery = focusedValue;
    let exactNumber = false;
    // PR URL も repository URL として解析できるため、repository の照合はここで 1 回だけ行う
    const repoUrl = parseGitHubRepoUrl(focusedValue);
    if (repoUrl) {
      if (`${repoUrl.owner}/${repoUrl.repo}`.toLowerCase() !== repo.fullName.toLowerCase()) {
        return c.json(autocompleteResponse([]));
      }
      // PR URL を貼り付けたときは、その番号の PR だけを候補に出す
      const prUrl = parseGitHubPrUrl(focusedValue);
      filterQuery = prUrl ? String(prUrl.number) : "";
      exactNumber = prUrl !== null;
    }

    const filtered = filterPullRequests(prList.items, filterQuery, exactNumber);
    const choices = filtered.map((pr) => ({
      name: formatPrChoiceName(pr),
      value: String(pr.number),
    }));

    return c.json(autocompleteResponse(choices));
  } catch (error) {
    // 空候補は利用者から障害と区別できないため、運用側が検知できるよう記録する
    console.error("discord_autocomplete_failed", { label: "pr", error: errorDetail(error) });
    return c.json(autocompleteResponse([]));
  }
};
