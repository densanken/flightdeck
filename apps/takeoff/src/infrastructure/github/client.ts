import { z } from "zod";

import {
  gitHubCheckRunsResponseSchema,
  gitHubCombinedStatusSchema,
  gitHubEffectiveBranchRulesSchema,
  gitHubInstallationReposResponseSchema,
  gitHubMergeResponseSchema,
  gitHubPullRequestSchema,
  gitHubPullRequestSummarySchema,
  gitHubRepositorySchema,
  gitHubWorkflowRunsResponseSchema,
  toGitHubRequiredStatusChecks,
} from "./types.js";
import { AppError } from "../../domain/errors.js";

import type { AppErrorType } from "../../domain/errors.js";
import type {
  GitHubCheckRunsResponse,
  GitHubClient,
  GitHubCombinedStatus,
  GitHubMergeResponse,
  GitHubPullRequest,
  GitHubPullRequestSummary,
  GitHubRepository,
  GitHubRequiredStatusCheck,
  GitHubWorkflowRun,
} from "../../usecase/github.js";

const GITHUB_API_BASE = "https://api.github.com";

export const GITHUB_API_VERSION = "2026-03-10";

// GitHub API 呼び出しの deadline
// 応答が停止すると waitUntil が実行期限（応答後最大 30 秒）まで占有され、
// merge 済みなのに Discord へ成功応答が届かない状態になるため、全呼び出しに上限を設ける
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

export const withGitHubTimeout = (): AbortSignal => AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);

const headers = (token: string) => ({
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "takeoff",
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
});

export class GitHubError extends AppError {
  constructor(
    type: AppErrorType,
    message: string,
    public readonly statusCode: number
  ) {
    super(type, message);
    this.name = "GitHubError";
  }
}

const readResponseText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

const readGitHubErrorMessage = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // JSON として解釈できない場合は response body をそのまま message として扱う
  }
  return body;
};

const createMergeMethodNotAllowedError = async (response: Response): Promise<GitHubError> => {
  const body = await readResponseText(response);
  const message = readGitHubErrorMessage(body);
  const normalized = message.toLowerCase();
  if (normalized.includes("merge conflict") || normalized.includes("not mergeable")) {
    return new GitHubError("merge_conflict", "Pull request is not mergeable", 409);
  }
  return new GitHubError("merge_blocked", `Pull request merge was rejected by GitHub: ${message}`, 409);
};

export const createGitHubResponseError = async (
  response: Response,
  errorContext: string,
  notFoundType: AppErrorType
): Promise<GitHubError> => {
  const body = (await readResponseText(response)).toLowerCase();
  const remaining = response.headers.get("x-ratelimit-remaining");
  const isRateLimited =
    response.status === 429 || remaining === "0" || response.headers.has("retry-after") || body.includes("rate limit");

  if (isRateLimited) {
    return new GitHubError("github_rate_limited", `GitHub rate limited: ${errorContext}`, 503);
  }
  if (response.status === 404) {
    return new GitHubError(notFoundType, `Not found: ${errorContext}`, 404);
  }
  // private repository で Rulesets を使えない GitHub plan の 403 は App 権限不足ではない
  // GitHub の案内文を識別し、恒久的な repository capability 不足として呼び出し元へ返す
  if (
    response.status === 403 &&
    body.includes("upgrade to github pro") &&
    body.includes("make this repository public") &&
    body.includes("enable this feature")
  ) {
    return new GitHubError(
      "github_rules_api_unavailable",
      `GitHub Rules API is unavailable for this repository: ${errorContext}`,
      409
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new GitHubError("github_app_permission_missing", `Permission denied: ${errorContext}`, 503);
  }
  return new GitHubError(
    "unexpected_github_error",
    `GitHub API error ${String(response.status)}: ${errorContext}`,
    502
  );
};

const parseResponse = async <T>(
  response: Response,
  schema: z.ZodType<T>,
  errorContext: string,
  notFoundType: AppErrorType
): Promise<T> => {
  if (!response.ok) {
    throw await createGitHubResponseError(response, errorContext, notFoundType);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new GitHubError("unexpected_github_error", `Invalid GitHub JSON response: ${errorContext}`, 502);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new GitHubError("unexpected_github_error", `Invalid GitHub response shape: ${errorContext}`, 502);
  }
  return parsed.data;
};

export class GitHubClientImpl implements GitHubClient {
  // module ロード時ではなく呼び出し時の globalThis.fetch を使う遅延束縛にする
  // （module scope の singleton でも test の fetch 差し替えが効くようにするため）
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async getRepository(token: string, owner: string, repo: string): Promise<GitHubRepository> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const response = await this.fetcher(`${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}`, {
      headers: headers(token),
      signal: withGitHubTimeout(),
    });
    return parseResponse(response, gitHubRepositorySchema, `getRepository ${owner}/${repo}`, "repo_not_found");
  }

  async getRepositoryById(token: string, repositoryId: number): Promise<GitHubRepository> {
    const response = await this.fetcher(`${GITHUB_API_BASE}/repositories/${String(repositoryId)}`, {
      headers: headers(token),
      signal: withGitHubTimeout(),
    });
    return parseResponse(
      response,
      gitHubRepositorySchema,
      `getRepositoryById ${String(repositoryId)}`,
      "repo_not_found"
    );
  }

  async listInstallationRepositories(token: string): Promise<GitHubRepository[]> {
    // installation repository は 100 件以下という運用前提で Link pagination を省略している
    // 100 件を超える organization を対象にするときは全 page の取得へ変更する
    const response = await this.fetcher(`${GITHUB_API_BASE}/installation/repositories?per_page=100`, {
      headers: headers(token),
      signal: withGitHubTimeout(),
    });
    const data = await parseResponse(
      response,
      gitHubInstallationReposResponseSchema,
      "listInstallationRepositories",
      "unexpected_github_error"
    );
    return data.repositories;
  }

  async listOpenPullRequests(token: string, owner: string, repo: string): Promise<GitHubPullRequestSummary[]> {
    // 1 repository あたりの open PR は 100 件以下という運用前提で Link pagination を省略している
    // 100 件を超える運用へ拡張するときは全 page の取得へ変更する
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const response = await this.fetcher(
      `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/pulls?state=open&per_page=100`,
      {
        headers: headers(token),
        signal: withGitHubTimeout(),
      }
    );
    return parseResponse(
      response,
      z.array(gitHubPullRequestSummarySchema),
      `listOpenPullRequests ${owner}/${repo}`,
      "repo_not_registered"
    );
  }

  async getPullRequest(token: string, owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const response = await this.fetcher(
      `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/pulls/${String(number)}`,
      {
        headers: headers(token),
        signal: withGitHubTimeout(),
      }
    );
    return parseResponse(
      response,
      gitHubPullRequestSchema,
      `getPullRequest ${owner}/${repo}#${String(number)}`,
      "pr_not_found"
    );
  }

  async listCheckRunsForRef(token: string, owner: string, repo: string, ref: string): Promise<GitHubCheckRunsResponse> {
    // check run は 100 件以下という仕様上の前提で Link pagination を省略している
    // 前提が破れて total_count が取得件数を超えた場合は fail-closed で error にする
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedRef = encodeURIComponent(ref);
    const response = await this.fetcher(
      `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/commits/${encodedRef}/check-runs?per_page=100`,
      {
        headers: headers(token),
        signal: withGitHubTimeout(),
      }
    );
    const data = await parseResponse(
      response,
      gitHubCheckRunsResponseSchema,
      `listCheckRunsForRef ${owner}/${repo}@${ref}`,
      "pr_not_found"
    );
    if (data.total_count > data.check_runs.length) {
      // 呼び出し元（merge, status usecase）は error message をそのまま Discord へ出さないため、
      // 詳細はここで log へ残す
      console.error("github_check_runs_exceed_single_page", {
        owner,
        repo,
        ref,
        totalCount: data.total_count,
        fetchedCount: data.check_runs.length,
      });
      throw new GitHubError(
        "unexpected_github_error",
        `Check runs exceed a single page (total=${String(data.total_count)}, fetched=${String(data.check_runs.length)}); ` +
          `merge gate cannot evaluate all checks: listCheckRunsForRef ${owner}/${repo}@${ref}`,
        502
      );
    }
    return data;
  }

  async getCombinedStatusForRef(
    token: string,
    owner: string,
    repo: string,
    ref: string
  ): Promise<GitHubCombinedStatus> {
    // commit status は 100 件以下という仕様上の前提で Link pagination を省略している
    // 前提が破れて total_count が取得件数を超えた場合は fail-closed で error にする（check runs と対称）
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedRef = encodeURIComponent(ref);
    const response = await this.fetcher(
      `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/commits/${encodedRef}/status?per_page=100`,
      {
        headers: headers(token),
        signal: withGitHubTimeout(),
      }
    );
    const data = await parseResponse(
      response,
      gitHubCombinedStatusSchema,
      `getCombinedStatusForRef ${owner}/${repo}@${ref}`,
      "pr_not_found"
    );
    if (data.total_count > data.statuses.length) {
      // 呼び出し元（merge, status usecase）は error message をそのまま Discord へ出さないため、
      // 詳細はここで log へ残す
      console.error("github_combined_status_exceed_single_page", {
        owner,
        repo,
        ref,
        totalCount: data.total_count,
        fetchedCount: data.statuses.length,
      });
      throw new GitHubError(
        "unexpected_github_error",
        `Combined status exceeds a single page (total=${String(data.total_count)}, fetched=${String(data.statuses.length)}); ` +
          `merge gate cannot evaluate all statuses: getCombinedStatusForRef ${owner}/${repo}@${ref}`,
        502
      );
    }
    return data;
  }

  async getRequiredStatusChecksForBranch(
    token: string,
    owner: string,
    repo: string,
    branch: string
  ): Promise<GitHubRequiredStatusCheck[]> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedBranch = encodeURIComponent(branch);
    const rules: Parameters<typeof toGitHubRequiredStatusChecks>[0] = [];
    let page = 1;

    for (;;) {
      const response = await this.fetcher(
        `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/rules/branches/${encodedBranch}?per_page=100&page=${String(page)}`,
        {
          headers: headers(token),
          signal: withGitHubTimeout(),
        }
      );
      const pageRules = await parseResponse(
        response,
        gitHubEffectiveBranchRulesSchema,
        `getRequiredStatusChecksForBranch ${owner}/${repo}@${branch} page=${String(page)}`,
        "repo_not_found"
      );
      rules.push(...pageRules);

      if (!response.headers.get("link")?.includes('rel="next"')) break;
      page += 1;
      if (page > 100) {
        throw new GitHubError(
          "unexpected_github_error",
          `Effective branch rules exceed pagination limit: getRequiredStatusChecksForBranch ${owner}/${repo}@${branch}`,
          502
        );
      }
    }

    const parsedRequiredChecks = toGitHubRequiredStatusChecks(rules);
    if (!parsedRequiredChecks.success) {
      throw new GitHubError(
        "unexpected_github_error",
        `Invalid required status checks rule: getRequiredStatusChecksForBranch ${owner}/${repo}@${branch}`,
        502
      );
    }
    return parsedRequiredChecks.data;
  }

  async mergePullRequest(
    token: string,
    owner: string,
    repo: string,
    number: number,
    options: {
      commitTitle: string;
      sha: string;
      mergeMethod: "squash";
      signal?: AbortSignal;
    }
  ): Promise<GitHubMergeResponse> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const response = await this.fetcher(
      `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/pulls/${String(number)}/merge`,
      {
        method: "PUT",
        headers: {
          ...headers(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          commit_title: options.commitTitle,
          sha: options.sha,
          merge_method: options.mergeMethod,
        }),
        signal: options.signal ? AbortSignal.any([withGitHubTimeout(), options.signal]) : withGitHubTimeout(),
      }
    );

    if (response.status === 409) {
      throw new GitHubError("head_sha_changed", "Head SHA has changed", 409);
    }
    if (response.status === 405) {
      throw await createMergeMethodNotAllowedError(response);
    }

    const result = await parseResponse(
      response,
      gitHubMergeResponseSchema,
      `mergePullRequest ${owner}/${repo}#${String(number)}`,
      "pr_not_found"
    );
    if (!result.merged) {
      throw new GitHubError("merge_conflict", "GitHub did not merge the pull request", 409);
    }
    return result;
  }

  async isOrgMember(token: string, org: string, username: string): Promise<boolean> {
    const encodedOrg = encodeURIComponent(org);
    const encodedUsername = encodeURIComponent(username);
    const response = await this.fetcher(`${GITHUB_API_BASE}/orgs/${encodedOrg}/members/${encodedUsername}`, {
      headers: headers(token),
      redirect: "manual",
      signal: withGitHubTimeout(),
    });
    if (response.status === 204) return true;
    if (response.status === 404 || response.status === 302) return false;
    throw await createGitHubResponseError(response, `isOrgMember ${org}/${username}`, "unexpected_github_error");
  }

  async approveWorkflowRun(token: string, owner: string, repo: string, runId: number): Promise<boolean> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const response = await this.fetcher(
      `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/actions/runs/${String(runId)}/approve`,
      {
        method: "POST",
        headers: headers(token),
        signal: withGitHubTimeout(),
      }
    );
    if (response.status === 201) return true;
    if (response.status === 403) return false;
    throw await createGitHubResponseError(
      response,
      `approveWorkflowRun ${owner}/${repo}#${String(runId)}`,
      "unexpected_github_error"
    );
  }

  async listActionRequiredRuns(
    token: string,
    owner: string,
    repo: string,
    headSha: string
  ): Promise<GitHubWorkflowRun[]> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedHeadSha = encodeURIComponent(headSha);
    const response = await this.fetcher(
      `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/actions/runs?head_sha=${encodedHeadSha}&status=action_required&event=pull_request&per_page=100`,
      {
        headers: headers(token),
        signal: withGitHubTimeout(),
      }
    );
    const data = await parseResponse(
      response,
      gitHubWorkflowRunsResponseSchema,
      `listActionRequiredRuns ${owner}/${repo}@${headSha}`,
      "unexpected_github_error"
    );
    if (data.total_count > data.workflow_runs.length) {
      console.error("github_action_required_runs_exceed_single_page", {
        owner,
        repo,
        headSha,
        totalCount: data.total_count,
        fetchedCount: data.workflow_runs.length,
      });
      throw new GitHubError(
        "unexpected_github_error",
        `Action-required workflow runs exceed a single page (total=${String(data.total_count)}, fetched=${String(data.workflow_runs.length)}); ` +
          `approval gate cannot inspect all runs: listActionRequiredRuns ${owner}/${repo}@${headSha}`,
        502
      );
    }
    return data.workflow_runs;
  }
}
