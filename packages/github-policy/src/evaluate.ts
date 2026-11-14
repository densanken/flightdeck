import {
  automergeDisabled,
  chooseConfig,
  classify,
  CONFIG_PATHS,
  ConfigError,
  humanActivity,
  parseAutopilotConfig,
  sourceOf,
  verifyGitlink,
  verifySourceHistory,
} from "@flightdeck/rules";

import { ciStatus } from "./ci.js";

import type {
  ConfigFile,
  GitlinkEntry,
  PolicyDecision,
  PolicyPullRequest,
  PolicySettings,
  RequiredStatusCheck,
} from "@flightdeck/rules";

export interface PolicyGateway {
  configs: (baseOid: string) => Promise<ConfigFile[]>;
  trees: (
    baseOid: string,
    headOid: string,
    path: string
  ) => Promise<{ base: GitlinkEntry | null; head: GitlinkEntry | null }>;
  compare: (source: string, newer: string, older: string) => Promise<{ source: string; ancestry: string }>;
  rules: (branch: string) => Promise<RequiredStatusCheck[]>;
}

const result = (kind: "skip" | "violated" | "undeterminable", reasonCode: string): PolicyDecision => ({
  kind,
  reasonCode,
});

const readConfig = async (github: PolicyGateway, baseOid: string) => {
  try {
    return parseAutopilotConfig(chooseConfig(await github.configs(baseOid))?.text ?? "");
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
};

export const decide = async (
  github: PolicyGateway,
  repositoryId: number,
  pr: PolicyPullRequest,
  settings: PolicySettings,
  now: number
): Promise<PolicyDecision> => {
  const policy = classify(pr.author?.id ?? null, settings.dispatchId, settings.renovateIds);

  if (pr.state !== "OPEN") return result("skip", "not_open");

  if (!policy) return result("skip", "unknown_author");

  const config = await readConfig(github, pr.baseOid);
  if (config instanceof ConfigError) return result("undeterminable", config.code);

  if (pr.draft) return result("violated", "draft");
  if (pr.labels.some((label) => label.toLowerCase() === "autopilot:skip")) return result("violated", "opted_out");
  if (pr.files.some((file) => Object.values(CONFIG_PATHS).includes(file.path))) {
    return result("violated", "config_changed");
  }
  if (pr.headRepositoryId !== repositoryId) return result("violated", "fork");
  if (pr.opinionatedReviews.some((review) => review.state === "CHANGES_REQUESTED" && review.author?.type === "User")) {
    return result("violated", "human_changes_requested");
  }

  if (policy === "dispatch") {
    const source = sourceOf(pr.branch);
    const file = pr.files[0];

    if (!source || pr.files.length !== 1 || file?.changeType !== "MODIFIED") return result("violated", "invalid_diff");
    if (!pr.submodulesComplete) return result("undeterminable", "submodules_truncated");

    const matches = pr.submodules.filter((item) => item.path === file.path);
    if (matches.length > 1) return result("undeterminable", "ambiguous_submodule");

    const trees = await github.trees(pr.baseOid, pr.headSha, file.path);
    const gitlink = { source, submoduleUrl: matches[0]?.gitUrl ?? null, ...trees };
    if (!verifyGitlink(gitlink)) return result("violated", "invalid_gitlink");

    const comparisons = await github.compare(source, gitlink.head.oid, gitlink.base.oid);
    const verified = verifySourceHistory(comparisons.source, comparisons.ancestry);
    if (verified !== "allowed") return result(verified, "invalid_source_history");
  } else {
    if (!config.renovateStale) return result("violated", "renovate_disabled");
    if (!automergeDisabled(pr.body)) return result("violated", "automerge_enabled");

    const activity = humanActivity({
      createdAt: pr.createdAt,
      editor: pr.editor,
      lastEditedAt: pr.lastEditedAt,
      timeline: pr.timeline,
      pageCount: pr.timelinePageCount,
      hasPreviousPage: pr.timelineHasPreviousPage,
      recentCount: pr.recentCount,
      renovateIds: settings.renovateIds,
      now,
    });
    if (activity !== "allowed") return result(activity, "human_activity");

    const status = await ciStatus(github, pr);
    if (status === "pending") return result("undeterminable", "ci_pending");
    if (status === "blocked") return result("violated", "ci_failed");
  }

  // GraphQL では改名元の path が分からず、設定ファイルの改名を否定できない
  if (
    policy === "renovate-stale" &&
    pr.files.some((file) => file.changeType === "RENAMED" || file.changeType === "COPIED")
  ) {
    return result("undeterminable", "config_rename_unknown");
  }

  return { kind: "allowed", policy, headSha: pr.headSha };
};
