export interface CommitIdentity {
  sha: string;
  authorId: number | null;
  authorEmail?: string | null | undefined;
  committerId: number | null;
  committerLogin: string | null;
  signature: { isValid: boolean; wasSignedByGitHub: boolean } | null;
}

export const invalidCommitIdentities = (commits: CommitIdentity[], pullRequestAuthorId: number): CommitIdentity[] =>
  commits.filter((commit) => {
    if (commit.authorId !== pullRequestAuthorId) return true;
    if (commit.committerId === pullRequestAuthorId) return false;

    return !(
      commit.committerId !== null &&
      commit.committerLogin?.toLowerCase() === "web-flow" &&
      commit.signature?.isValid === true &&
      commit.signature.wasSignedByGitHub
    );
  });
