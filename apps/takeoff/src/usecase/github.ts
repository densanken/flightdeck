export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  owner: {
    login: string;
  };
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  merge_commit_sha?: string | null;
  head: {
    sha: string;
    ref: string;
  };
  base: {
    ref: string;
    sha: string;
    repo: {
      id: number;
    };
  };
  user: {
    login: string;
  } | null;
  updated_at: string;
}

// List Pull Requests は単一 PR 取得と異なり mergeable を返さない
export type GitHubPullRequestSummary = Omit<GitHubPullRequest, "mergeable">;

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  app: {
    id: number;
    slug?: string;
  } | null;
}

export interface GitHubCheckRunsResponse {
  total_count: number;
  check_runs: GitHubCheckRun[];
}

export interface GitHubStatusContext {
  state: string;
  context: string;
  target_url: string | null;
}

export interface GitHubCombinedStatus {
  state: string;
  total_count: number;
  statuses: GitHubStatusContext[];
}

export interface GitHubMergeResponse {
  sha: string;
  merged: boolean;
  message: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  status: string;
  actor: {
    login: string;
  };
}

export interface GitHubRequiredStatusCheck {
  context: string;
  integrationId: number | null;
}

export interface GitHubClient {
  getRepository(token: string, owner: string, repo: string): Promise<GitHubRepository>;
  getRepositoryById(token: string, repositoryId: number): Promise<GitHubRepository>;
  listInstallationRepositories(token: string): Promise<GitHubRepository[]>;
  listOpenPullRequests(token: string, owner: string, repo: string): Promise<GitHubPullRequestSummary[]>;
  getPullRequest(token: string, owner: string, repo: string, number: number): Promise<GitHubPullRequest>;
  listCheckRunsForRef(token: string, owner: string, repo: string, ref: string): Promise<GitHubCheckRunsResponse>;
  getCombinedStatusForRef(token: string, owner: string, repo: string, ref: string): Promise<GitHubCombinedStatus>;
  getRequiredStatusChecksForBranch(
    token: string,
    owner: string,
    repo: string,
    branch: string
  ): Promise<GitHubRequiredStatusCheck[]>;
  mergePullRequest(
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
  ): Promise<GitHubMergeResponse>;
  isOrgMember(token: string, org: string, username: string): Promise<boolean>;
  approveWorkflowRun(token: string, owner: string, repo: string, runId: number): Promise<boolean>;
  listActionRequiredRuns(token: string, owner: string, repo: string, headSha: string): Promise<GitHubWorkflowRun[]>;
}

export interface InstallationTokenProvider {
  getToken(): Promise<string>;
}
