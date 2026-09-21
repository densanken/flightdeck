export interface AssignPullRequestAuthorInput {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  author: string;
}

export interface GitHubAssignmentGateway {
  readonly assignPullRequestAuthor: (input: AssignPullRequestAuthorInput, signal: AbortSignal) => Promise<boolean>;
}

export interface AssignmentUseCaseDependencies {
  githubGateway: GitHubAssignmentGateway;
  skipBots: boolean;
}
