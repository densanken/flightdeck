import type { PolicyGateway } from "@flightdeck/github-policy";
import type { Logger } from "@flightdeck/logger";
import type { PolicyPullRequest, PolicySettings } from "@flightdeck/rules";

export const EXECUTION_TIMEOUT_MS = 25_000;

export interface MergeSettings extends PolicySettings {
  botUserId: number;
}

export interface MergeGateway extends PolicyGateway {
  authenticate(): Promise<void>;
  associated(sha: string, repositoryId: number): Promise<number[]>;
  pullRequest(number: number, now: number): Promise<{ repositoryId: number; pr: PolicyPullRequest }>;
  merge(number: number, sha: string): Promise<{ merged: boolean; status: number }>;
  subrequests(): number;
}

export interface MergeDependencies {
  github: MergeGateway;
  settings: MergeSettings;
  logger: Logger;
  clock: () => number;
  maxSubrequests: number;
}
