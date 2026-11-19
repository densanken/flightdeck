import type { CommitIdentity } from "../../domain/commit-identity.js";
import type { Membership, Person } from "../../domain/editors.js";
import type { MergeData } from "../../domain/merge.js";
import type { ChangedFile } from "../../domain/paths.js";
import type { Review } from "../../domain/reviews.js";

export interface PullRequestData {
  state: string;
  mergeData: MergeData;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  isCrossRepository: boolean;
  headRepositoryId: number | null;
  author: Person & { isBot?: boolean | undefined };
  files: ChangedFile[];
  commits: CommitIdentity[];
  reviews: (Review & { login: string; isBot?: boolean | undefined })[];
  baseRoots: string[];
}

export interface RootFiles {
  metaYaml: string | null;
  metaYml: string | null;
  profileYaml: string | null;
  profileYml: string | null;
}

export interface RootFilesPair {
  root: string;
  before: RootFiles;
  after: RootFiles;
}

export interface EvaluateGateway {
  files: (
    baseSha: string,
    headSha: string,
    roots: string[],
    profileRoots: string[],
    metaRoots: string[]
  ) => Promise<RootFilesPair[]>;
  validateEditors: (editors: string[], teams: string[]) => Promise<Person[]>;
  teamMemberships: (people: Person[], teams: string[]) => Promise<Membership[]>;
  orgMembership: (person: Person) => Promise<"admin" | "member" | null>;
}
