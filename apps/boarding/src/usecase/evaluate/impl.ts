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
import { managementApproval, memberRequest } from "../../domain/management.js";
import {
  offboardingChangeViolation,
  offboardingTargetViolation,
  removedEditors,
  rootManagementMode,
} from "../../domain/offboarding.js";
import { classifyPaths, collidingAuthorRoots } from "../../domain/paths.js";
import { approvedPeople } from "../../domain/reviews.js";
import { BoardingError } from "../../errors.js";
import { errorResult } from "../error-result.js";

import type { EvaluateGateway, PullRequestData, RootFiles, RootFilesPair } from "./dependencies.js";
import type { EvaluateUseCase, EvaluationResult } from "./interface.js";
import type { AuthorizationResult } from "../../domain/authorization.js";
import type { AuthorRoot, Editor, Membership, Person } from "../../domain/editors.js";
import type { ManagementApprovalReason, ManagementRequest } from "../../domain/management.js";
import type { MetaKeys, OffboardingTargetReason } from "../../domain/offboarding.js";

interface RootChanges {
  profile: string[];
  meta: string[];
}

interface Context {
  pr: PullRequestData;
  roots: AuthorRoot[];
  editors: Editor[];
  people: Person[];
  author: Membership;
  management: ManagementRequest;
  otherPaths: string[];
}

interface Outcome {
  result: AuthorizationResult;
  root?: AuthorRoot | undefined;
}

export class EvaluateUseCaseImpl implements EvaluateUseCase {
  constructor(
    private readonly dependencies: {
      gateway: EvaluateGateway;
      readEditors: (files: RootFiles) => Editor[] | null;
      readWebsite: (files: RootFiles) => string | null;
      readMetaKeys: (files: RootFiles) => string[] | null;
    }
  ) {}

  async execute(pr: PullRequestData, request: ManagementRequest): Promise<EvaluationResult> {
    const { authorRoots, otherPaths } = classifyPaths(pr.files);
    const invalidCommits = invalidCommitIdentities(pr.commits, pr.author.id);
    const facts = { authorRoots, otherPaths, invalidCommits };
    const management = request.mode === "none" ? request : undefined;

    try {
      if (collidingAuthorRoots(authorRoots, pr.baseRoots).length > 0) {
        return { status: "rejected", reason: "AUTHOR_ROOT_CASE_CONFLICT", facts, management };
      }

      if (invalidCommits.length > 0 || pr.commits.length === 0) {
        return { status: "rejected", reason: "COMMIT_IDENTITY_MISMATCH", facts, management };
      }

      return { ...(await this.evaluate(pr, authorRoots, otherPaths, request)), facts };
    } catch (error) {
      if (error instanceof BoardingError && error.code === "INVALID_METADATA") {
        return { status: "rejected", reason: "INVALID_EDITORS", facts, management };
      }

      if (error instanceof BoardingError && error.code === "INVALID_PROFILE") {
        return { status: "rejected", reason: "INVALID_PROFILE", facts, management };
      }

      if (error instanceof BoardingError && error.code === "YAML_SIZE_LIMIT") {
        return { status: "error", reason: "YAML_SIZE_LIMIT", facts, management };
      }

      return { ...errorResult(error), facts, management };
    }
  }

  private async evaluate(
    pr: PullRequestData,
    authorRoots: string[],
    otherPaths: string[],
    request: ManagementRequest
  ): Promise<EvaluationResult> {
    const changes = {
      profile: changedRoots(pr.files, authorRoots, "profile"),
      meta: changedRoots(pr.files, authorRoots, "meta"),
    };
    const { gateway } = this.dependencies;
    const files = await gateway.files(pr.baseSha, pr.headSha, authorRoots, changes.profile, changes.meta);
    const authorRole =
      request.mode === "none" ? undefined : pr.author.isBot ? null : await gateway.orgMembership(pr.author);
    const management = memberRequest(request, authorRole);

    if (management.mode === "offboarding") {
      const reason = offboardingChangeViolation(pr.files, this.readOffboardingKeys(files));
      if (reason) return { status: "rejected", reason, management };
    }

    const context = await this.loadContext(pr, files, changes, otherPaths, management, authorRole);
    const outcome = await this.evaluateContext(context);

    return this.evaluationResult(context, outcome);
  }

  private evaluationResult(context: Context, outcome: Outcome): EvaluationResult {
    return {
      ...outcome.result,
      rootEditors: context.roots.map(({ name, after }) => ({ name, editors: after })),
      details: {
        ...outcome.result.details,
        root: outcome.root?.name,
      },
      management: {
        ...context.management,
        targets: context.management.mode === "offboarding" ? removedEditors(context.roots) : [],
      },
    };
  }

  private async evaluateContext(context: Context): Promise<Outcome> {
    const eligibility = this.checkEligibility(context);
    if (eligibility) return eligibility;

    const offboarding = await this.checkOffboarding(context);
    if (offboarding.reason) {
      return { result: { status: "rejected", reason: offboarding.reason } };
    }

    return this.authorize(context, offboarding.memberships);
  }

  private async loadContext(
    pr: PullRequestData,
    files: RootFilesPair[],
    changes: RootChanges,
    otherPaths: string[],
    management: ManagementRequest,
    authorRole: Membership["orgRole"]
  ): Promise<Context> {
    const roots = this.loadRoots(pr, files, changes);
    const editors = uniqueEditors(roots);
    const { users, teams } = splitEditors(editors);
    const people = await this.dependencies.gateway.validateEditors(users, teams);
    const author = await this.loadAuthor(pr, roots, teams, otherPaths.length > 0, authorRole);

    return {
      pr,
      roots,
      editors,
      people,
      author,
      otherPaths,
      management,
    };
  }

  private checkEligibility(context: Context): Outcome | undefined {
    const { author, otherPaths, roots } = context;

    if (otherPaths.length > 0 && !isOrgMember(author)) {
      return { result: { status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" } };
    }

    if (roots.length === 0) {
      return { result: { status: "not_applicable", reason: "NO_CONTENT_CHANGES" } };
    }

    return undefined;
  }

  private async checkOffboarding(context: Context): Promise<{
    reason: OffboardingTargetReason | undefined;
    memberships: Membership[];
  }> {
    if (context.management.mode !== "offboarding") return { reason: undefined, memberships: [] };

    const memberships = await this.loadTargets(context);

    return { reason: offboardingTargetViolation(context.roots, memberships), memberships };
  }

  private async loadTargets(context: Context): Promise<Membership[]> {
    const logins = [...new Set(splitEditors(removedEditors(context.roots)).users.map((login) => login.toLowerCase()))];
    const memberships: Membership[] = [];

    for (const login of logins) {
      const person = context.people.find((candidate) => candidate.login.toLowerCase() === login);
      if (!person) throw new BoardingError("INVALID_RESPONSE", "Editor identity is missing");

      memberships.push(await this.loadOrgMembership(person, [context.author, ...memberships]));
    }

    return memberships;
  }

  private async authorize(context: Context, targets: Membership[]): Promise<Outcome> {
    const initial = this.rootResults(context, [context.author]);
    const rejected = initial.find(({ result }) => result.status === "rejected");
    if (rejected) return rejected;

    const pending = initial.filter(({ result }) => result.status === "waiting").map(({ root }) => root);
    const memberships = await this.loadReviewers(context.pr, pending, [context.author]);
    const approval = await this.checkManagement(context, [...memberships, ...targets]);

    if (approval) {
      return { result: { status: "waiting", reason: approval } };
    }

    const incomplete = this.rootResults(context, memberships).find(({ result }) => result.status !== "allowed");

    return {
      result: incomplete?.result ?? { status: "allowed", reason: "AUTHORIZED" },
      root: incomplete?.root,
    };
  }

  private rootResults(
    context: Context,
    memberships: Membership[]
  ): { root: AuthorRoot; result: AuthorizationResult }[] {
    const consents = buildConsents(memberships, context.editors);
    const mode = context.management.mode === "none" ? undefined : context.management.mode;

    return context.roots.map((root) => ({
      root,
      result: authorizeRoot({
        ...root,
        authorId: context.pr.author.id,
        consents,
        mode: rootManagementMode(root, mode),
      }),
    }));
  }

  private async checkManagement(context: Context, known: Membership[]): Promise<ManagementApprovalReason | undefined> {
    const mode = context.management.mode;
    if (mode === "none") return undefined;

    const people = approvedPeople(context.pr.reviews, context.pr.headSha, context.pr.author.id);
    const reviewers: Membership[] = [];
    for (const person of people) reviewers.push(await this.loadOrgMembership(person, known));

    return managementApproval(reviewers, context.pr.author.id, mode);
  }

  private async loadOrgMembership(person: Person, known: Membership[]): Promise<Membership> {
    const matches = known.filter((member) => member.person.id === person.id);
    const existing = matches.find((member) => member.orgRole !== undefined) ?? matches[0];
    if (existing?.orgRole !== undefined) return existing;

    return { person, orgRole: await this.dependencies.gateway.orgMembership(person), teams: existing?.teams ?? {} };
  }

  private readOffboardingKeys(files: RootFilesPair[]): MetaKeys[] {
    return files.map(({ before, after }) => ({
      before: this.dependencies.readMetaKeys(before),
      after: this.dependencies.readMetaKeys(after),
    }));
  }

  private loadRoots(pr: PullRequestData, files: RootFilesPair[], changes: RootChanges): AuthorRoot[] {
    return files.map(({ root, before, after }) =>
      this.parseRoot(pr, root, before, after, changes.profile.includes(root), changes.meta.includes(root))
    );
  }

  private parseRoot(
    pr: PullRequestData,
    name: string,
    beforeFiles: RootFiles,
    afterFiles: RootFiles,
    profileChanged: boolean,
    metaChanged: boolean
  ): AuthorRoot {
    const { readEditors, readWebsite } = this.dependencies;
    const before = readEditors(beforeFiles);
    const after = metaChanged ? readEditors(afterFiles) : before;

    if (before === null && pr.baseRoots.includes(name)) {
      throw new BoardingError("INVALID_METADATA", "Base metadata is missing");
    }
    if (!after) throw new BoardingError("INVALID_METADATA", "Head metadata is missing");

    const beforeWebsite = profileChanged ? readWebsite(beforeFiles) : null;
    const afterWebsite = profileChanged ? readWebsite(afterFiles) : null;

    return { name, before, after, websiteAddedOrChanged: afterWebsite !== null && beforeWebsite !== afterWebsite };
  }

  private async loadAuthor(
    pr: PullRequestData,
    roots: AuthorRoot[],
    teams: string[],
    hasOtherPaths: boolean,
    knownRole: Membership["orgRole"]
  ): Promise<Membership> {
    const authorTeams: Membership[] = pr.author.isBot
      ? [{ person: pr.author, orgRole: null, teams: {} }]
      : await this.dependencies.gateway.teamMemberships([pr.author], teams);

    const author = authorTeams.find((membership) => membership.person.id === pr.author.id);
    if (!author) throw new BoardingError("INVALID_RESPONSE", "Author membership is missing");

    if (knownRole !== undefined) return { ...author, orgRole: knownRole };

    if (
      !pr.author.isBot &&
      !isOrgMember(author) &&
      (hasOtherPaths || roots.some((root) => websiteCandidate(author, root)))
    ) {
      return { ...author, orgRole: await this.dependencies.gateway.orgMembership(pr.author) };
    }

    return author;
  }

  private async loadReviewers(
    pr: PullRequestData,
    pending: AuthorRoot[],
    authors: Membership[]
  ): Promise<Membership[]> {
    const { users, teams } = splitEditors(uniqueEditors(pending));
    const logins = new Set(users.map((login) => login.toLowerCase()));
    const people = approvedPeople(pr.reviews, pr.headSha, pr.author.id).filter(
      (person) => teams.length > 0 || logins.has(person.login.toLowerCase())
    );
    if (people.length === 0) return authors;

    const reviewers = await this.dependencies.gateway.teamMemberships(people, teams);
    if (reviewers.length !== people.length) {
      throw new BoardingError("INVALID_RESPONSE", "Reviewer membership is missing");
    }

    return [...authors, ...(await this.loadWebsiteMemberships(pending, authors, reviewers))];
  }

  private async loadWebsiteMemberships(
    pending: AuthorRoot[],
    authors: Membership[],
    reviewers: Membership[]
  ): Promise<Membership[]> {
    const known = [...authors, ...reviewers].filter(isOrgMember);
    const unresolved = new Set(
      pending.filter((root) => root.websiteAddedOrChanged && !known.some((member) => websiteCandidate(member, root)))
    );
    const memberships: Membership[] = [];

    for (const membership of reviewers) {
      const affected = [...unresolved].filter((root) => websiteCandidate(membership, root));
      if (isOrgMember(membership) || affected.length === 0) {
        memberships.push(membership);
        continue;
      }

      const orgRole = await this.dependencies.gateway.orgMembership(membership.person);
      if (orgRole !== null) for (const root of affected) unresolved.delete(root);
      memberships.push({ ...membership, orgRole });
    }

    return memberships;
  }
}
