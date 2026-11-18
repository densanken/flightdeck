import { authorizeRoot } from "../../domain/authorization.js";
import { invalidCommitIdentities } from "../../domain/commit-identity.js";
import {
  buildConsents,
  changedRoots,
  isOrgMember,
  splitEditors,
  uniqueEditors,
  websiteCandidate,
} from "../../domain/editors.js";
import { classifyPaths, collidingAuthorRoots } from "../../domain/paths.js";
import { approvedReviewers } from "../../domain/reviews.js";
import { BoardingError } from "../../errors.js";
import { errorResult } from "../error-result.js";

import type { EvaluateGateway, PullRequestData, RootFiles } from "./dependencies.js";
import type { EvaluateUseCase, EvaluationResult } from "./interface.js";
import type { AuthorizationResult } from "../../domain/authorization.js";
import type { AuthorRoot, Editor, Membership } from "../../domain/editors.js";

const withDetails = (result: AuthorizationResult, memberships: Membership[], root?: AuthorRoot): EvaluationResult => {
  const details = {
    ...result.details,
    memberships: memberships.map(({ person, orgRole, teams }) => ({ login: person.login, orgRole, teams })),
  };
  if (!root) return { ...result, details };

  return {
    ...result,
    details: {
      ...details,
      root: root.name,
    },
  };
};

export class EvaluateUseCaseImpl implements EvaluateUseCase {
  constructor(
    private readonly dependencies: {
      gateway: EvaluateGateway;
      readEditors: (files: RootFiles) => Editor[] | null;
      readWebsite: (files: RootFiles) => string | null;
    }
  ) {}

  async execute(pr: PullRequestData): Promise<EvaluationResult> {
    const { authorRoots, otherPaths } = classifyPaths(pr.files);
    const invalidCommits = invalidCommitIdentities(pr.commits, pr.author.id);
    const facts = { authorRoots, otherPaths, invalidCommits };

    try {
      if (collidingAuthorRoots(authorRoots, pr.baseRoots).length > 0) {
        return { status: "rejected", reason: "AUTHOR_ROOT_CASE_CONFLICT", facts };
      }

      if (invalidCommits.length > 0 || pr.commits.length === 0) {
        return { status: "rejected", reason: "COMMIT_IDENTITY_MISMATCH", facts };
      }

      return { ...(await this.evaluate(pr, authorRoots, otherPaths)), facts };
    } catch (error) {
      if (error instanceof BoardingError && error.code === "INVALID_METADATA") {
        return { status: "rejected", reason: "INVALID_EDITORS", facts };
      }

      if (error instanceof BoardingError && error.code === "INVALID_PROFILE") {
        return { status: "rejected", reason: "INVALID_PROFILE", facts };
      }

      if (error instanceof BoardingError && error.code === "YAML_SIZE_LIMIT") {
        return { status: "error", reason: "YAML_SIZE_LIMIT", facts };
      }

      return { ...errorResult(error), facts };
    }
  }

  private async evaluate(pr: PullRequestData, authorRoots: string[], otherPaths: string[]): Promise<EvaluationResult> {
    const roots = await this.loadRoots(pr, authorRoots);
    const editors = uniqueEditors(roots);
    const { users, teams } = splitEditors(editors);
    await this.dependencies.gateway.validateEditors(users, teams);

    const author = await this.loadAuthor(pr, roots, teams, otherPaths.length > 0);
    const authorMemberships = [author];

    if (otherPaths.length > 0 && !isOrgMember(author)) {
      return withDetails({ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" }, authorMemberships);
    }
    if (roots.length === 0) {
      return withDetails({ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, authorMemberships);
    }

    const authorConsents = buildConsents(authorMemberships, editors);
    const initial = roots.map((root) => ({
      root,
      result: authorizeRoot({ ...root, authorId: pr.author.id, consents: authorConsents }),
    }));

    const rejected = initial.find(({ result }) => result.status === "rejected");
    if (rejected) return withDetails(rejected.result, authorMemberships, rejected.root);

    const pending = initial.filter(({ result }) => result.status === "waiting").map(({ root }) => root);
    const memberships = await this.loadReviewers(pr, pending, authorMemberships);
    const consents = buildConsents(memberships, editors);

    for (const root of roots) {
      const result = authorizeRoot({ ...root, authorId: pr.author.id, consents });
      if (result.status !== "allowed") return withDetails(result, memberships, root);
    }

    return withDetails({ status: "allowed", reason: "AUTHORIZED" }, memberships);
  }

  private async loadRoots(pr: PullRequestData, authorRoots: string[]): Promise<AuthorRoot[]> {
    const { gateway, readEditors, readWebsite } = this.dependencies;
    const profileRoots = changedRoots(pr.files, authorRoots, "profile");
    const metaRoots = changedRoots(pr.files, authorRoots, "meta");
    const files = await gateway.files(pr.baseSha, pr.headSha, authorRoots, profileRoots, metaRoots);

    return files.map(({ root, before: beforeFiles, after: afterFiles }) => {
      const before = readEditors(beforeFiles);
      const after = metaRoots.includes(root) ? readEditors(afterFiles) : before;
      if (before === null && pr.baseRoots.includes(root)) {
        throw new BoardingError("INVALID_METADATA", "Base metadata is missing");
      }
      if (!after) throw new BoardingError("INVALID_METADATA", "Head metadata is missing");

      const changed = profileRoots.includes(root);
      const beforeWebsite = changed ? readWebsite(beforeFiles) : null;
      const afterWebsite = changed ? readWebsite(afterFiles) : null;

      return {
        name: root,
        before,
        after,
        websiteAddedOrChanged: afterWebsite !== null && beforeWebsite !== afterWebsite,
      };
    });
  }

  private async loadAuthor(
    pr: PullRequestData,
    roots: AuthorRoot[],
    teams: string[],
    hasOtherPaths: boolean
  ): Promise<Membership> {
    const { gateway } = this.dependencies;

    const authorTeams: Membership[] = pr.author.isBot
      ? [{ person: pr.author, orgRole: null, teams: {} }]
      : await gateway.teamMemberships([pr.author], teams);

    const author = authorTeams.find((membership) => membership.person.id === pr.author.id);
    if (!author) throw new BoardingError("INVALID_RESPONSE", "Author membership is missing");

    if (
      !pr.author.isBot &&
      !isOrgMember(author) &&
      (hasOtherPaths || roots.some((root) => websiteCandidate(author, root)))
    ) {
      return { ...author, orgRole: await gateway.orgMembership(pr.author) };
    }

    return author;
  }

  private async loadReviewers(
    pr: PullRequestData,
    pending: AuthorRoot[],
    authors: Membership[]
  ): Promise<Membership[]> {
    const { gateway } = this.dependencies;
    const approved = new Set(approvedReviewers(pr.reviews, pr.headSha, pr.author.id));
    const editors = uniqueEditors(pending);
    const { users, teams } = splitEditors(editors);
    const userLogins = new Set(users.map((login) => login.toLowerCase()));

    const reviewers = pr.reviews
      .filter(
        (review) =>
          !review.isBot &&
          approved.has(review.reviewerId) &&
          (teams.length > 0 || userLogins.has(review.login.toLowerCase()))
      )
      .map((review) => ({ id: review.reviewerId, login: review.login }));

    const uniqueReviewers = [...new Map(reviewers.map((person) => [person.id, person])).values()];
    if (uniqueReviewers.length === 0) return authors;

    const reviewerMemberships = await gateway.teamMemberships(uniqueReviewers, teams);
    if (reviewerMemberships.length !== uniqueReviewers.length) {
      throw new BoardingError("INVALID_RESPONSE", "Reviewer membership is missing");
    }

    const knownMemberships = [...authors, ...reviewerMemberships].filter(isOrgMember);
    const unresolved = new Set(
      pending.filter(
        (root) => root.websiteAddedOrChanged && !knownMemberships.some((member) => websiteCandidate(member, root))
      )
    );
    const memberships: Membership[] = [];

    for (const membership of reviewerMemberships) {
      const affected = [...unresolved].filter((root) => websiteCandidate(membership, root));
      if (isOrgMember(membership) || affected.length === 0) {
        memberships.push(membership);
        continue;
      }

      const orgRole = await gateway.orgMembership(membership.person);
      if (orgRole !== null) {
        for (const root of affected) unresolved.delete(root);
      }
      memberships.push({ ...membership, orgRole });
    }

    return [...authors, ...memberships];
  }
}
