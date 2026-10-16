import type {
  GitHubCheckRunsResponse,
  GitHubClient,
  GitHubCombinedStatus,
  GitHubMergeResponse,
  GitHubPullRequest,
  GitHubPullRequestSummary,
  GitHubRepository,
  GitHubRequiredStatusCheck,
  GitHubWorkflowFile,
  GitHubWorkflowRun,
} from "./github.js";

export class MockGitHubClient implements GitHubClient {
  repositories: GitHubRepository[] = [];
  pullRequests: GitHubPullRequest[] = [];
  pullRequestSummaries: GitHubPullRequestSummary[] = [];
  checkRuns: GitHubCheckRunsResponse = { total_count: 0, check_runs: [] };
  combinedStatus: GitHubCombinedStatus = { state: "pending", total_count: 0, statuses: [] };
  requiredStatusChecks: GitHubRequiredStatusCheck[] = [];
  mergeResponse: GitHubMergeResponse = { sha: "merge-sha", merged: true, message: "merged" };
  listOpenPullRequestsCalls = 0;

  getRepository(_token: string, owner: string, repo: string): Promise<GitHubRepository> {
    const repository = this.repositories.find(
      (candidate) => candidate.owner.login === owner && candidate.name === repo
    );
    if (!repository) return Promise.reject(new Error("Repository not configured"));
    return Promise.resolve(repository);
  }

  getRepositoryById(_token: string, repositoryId: number): Promise<GitHubRepository> {
    const repository = this.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) return Promise.reject(new Error("Repository not configured"));
    return Promise.resolve(repository);
  }

  listInstallationRepositories(_token: string): Promise<GitHubRepository[]> {
    return Promise.resolve(this.repositories);
  }

  listOpenPullRequests(_token: string, _owner: string, _repo: string): Promise<GitHubPullRequestSummary[]> {
    this.listOpenPullRequestsCalls += 1;
    return Promise.resolve(this.pullRequestSummaries);
  }

  getPullRequest(_token: string, _owner: string, _repo: string, number: number): Promise<GitHubPullRequest> {
    const pullRequest = this.pullRequests.find((candidate) => candidate.number === number);
    if (!pullRequest) return Promise.reject(new Error("Pull request not configured"));
    return Promise.resolve(pullRequest);
  }

  listCheckRunsForRef(_token: string, _owner: string, _repo: string, _ref: string): Promise<GitHubCheckRunsResponse> {
    return Promise.resolve(this.checkRuns);
  }

  getCombinedStatusForRef(_token: string, _owner: string, _repo: string, _ref: string): Promise<GitHubCombinedStatus> {
    return Promise.resolve(this.combinedStatus);
  }

  getRequiredStatusChecksForBranch(
    _token: string,
    _owner: string,
    _repo: string,
    _branch: string
  ): Promise<GitHubRequiredStatusCheck[]> {
    return Promise.resolve(this.requiredStatusChecks);
  }

  mergePullRequest(
    _token: string,
    _owner: string,
    _repo: string,
    _number: number,
    _options: {
      commitTitle: string;
      sha: string;
      mergeMethod: "squash";
    }
  ): Promise<GitHubMergeResponse> {
    return Promise.resolve(this.mergeResponse);
  }

  orgMembers = new Set<string>();
  approvedRunIds = new Set<number>();
  workflowRuns: GitHubWorkflowRun[] = [];

  isOrgMember(_token: string, _org: string, username: string): Promise<boolean> {
    return Promise.resolve(this.orgMembers.has(username));
  }

  approveWorkflowRun(_token: string, _owner: string, _repo: string, runId: number): Promise<boolean> {
    if (this.approvedRunIds.has(runId)) return Promise.resolve(false);
    this.approvedRunIds.add(runId);
    return Promise.resolve(true);
  }

  listActionRequiredRuns(
    _token: string,
    _owner: string,
    _repo: string,
    _headSha: string
  ): Promise<GitHubWorkflowRun[]> {
    return Promise.resolve(this.workflowRuns);
  }

  // ref ごとの .github/workflows の中身で、未設定の ref は workflow を持たない commit として扱う
  workflowFiles = new Map<string, GitHubWorkflowFile[]>();

  listWorkflowFiles(_token: string, _owner: string, _repo: string, ref: string): Promise<GitHubWorkflowFile[]> {
    return Promise.resolve(this.workflowFiles.get(ref) ?? []);
  }

  pullRequestFilePaths: string[] = [];

  listPullRequestFilePaths(_token: string, _owner: string, _repo: string, _number: number): Promise<string[]> {
    return Promise.resolve(this.pullRequestFilePaths);
  }
}
