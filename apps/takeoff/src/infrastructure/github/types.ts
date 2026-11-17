import { commitSha, githubId, repositoryFullName } from "@flightdeck/validation";
import * as v from "valibot";

import type {
  GitHubCheckRun,
  GitHubCheckRunsResponse,
  GitHubCombinedStatus,
  GitHubMergeResponse,
  GitHubPullRequest,
  GitHubPullRequestSummary,
  GitHubRepository,
  GitHubRequiredStatusCheck,
  GitHubStatusContext,
  GitHubWorkflowFile,
  GitHubWorkflowRun,
} from "../../usecase/github.js";

const url = v.pipe(v.string(), v.url());

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const utcDateTime = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/),
  v.check((value) => {
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
  })
);

// GitHub response の parse には schema が要るため port（usecase/github.ts）と型が二重に見えるが、
// 契約の所有者は port に一本化し、ここでは satisfies で schema の出力が port の型からずれたら compile error にする
export const gitHubRepositorySchema = v.object({
  id: githubId,
  name: v.string(),
  full_name: repositoryFullName,
  html_url: url,
  owner: v.object({ login: v.string() }),
}) satisfies v.GenericSchema<unknown, GitHubRepository>;

const pullRequestEntries = {
  number: githubId,
  title: v.string(),
  html_url: url,
  state: v.string(),
  draft: v.boolean(),
  merge_commit_sha: v.nullish(commitSha),
  head: v.object({ sha: commitSha, ref: v.string(), label: v.string(), repo: v.nullable(v.object({ id: githubId })) }),
  base: v.object({ ref: v.string(), sha: commitSha, repo: v.object({ id: githubId }) }),
  user: v.nullable(v.object({ login: v.string() })),
  updated_at: utcDateTime,
};

export const gitHubPullRequestSchema = v.object({
  ...pullRequestEntries,
  mergeable: v.nullable(v.boolean()),
}) satisfies v.GenericSchema<unknown, GitHubPullRequest>;

export const gitHubPullRequestSummarySchema = v.object(pullRequestEntries) satisfies v.GenericSchema<
  unknown,
  GitHubPullRequestSummary
>;

export const gitHubCheckRunSchema = v.object({
  id: githubId,
  name: v.string(),
  status: v.string(),
  conclusion: v.nullable(v.string()),
  html_url: v.nullable(url),
  app: v.nullable(v.object({ id: githubId, slug: v.optional(v.string()) })),
}) satisfies v.GenericSchema<unknown, GitHubCheckRun>;

export const gitHubCheckRunsResponseSchema = v.object({
  total_count: count,
  check_runs: v.array(gitHubCheckRunSchema),
}) satisfies v.GenericSchema<unknown, GitHubCheckRunsResponse>;

export const gitHubStatusContextSchema = v.object({
  state: v.string(),
  context: v.string(),
  target_url: v.nullable(url),
}) satisfies v.GenericSchema<unknown, GitHubStatusContext>;

export const gitHubCombinedStatusSchema = v.object({
  total_count: count,
  state: v.string(),
  statuses: v.array(gitHubStatusContextSchema),
}) satisfies v.GenericSchema<unknown, GitHubCombinedStatus>;

export const gitHubMergeResponseSchema = v.object({
  sha: commitSha,
  merged: v.boolean(),
  message: v.string(),
}) satisfies v.GenericSchema<unknown, GitHubMergeResponse>;

// Contents API でディレクトリを取得すると、直下の entry の配列が返る
export const gitHubWorkflowFilesSchema = v.array(
  v.object({ path: v.string(), sha: commitSha })
) satisfies v.GenericSchema<unknown, GitHubWorkflowFile[]>;

// rename された file は変更前の path も持つ
export const gitHubPullRequestFilesSchema = v.array(
  v.object({ filename: v.string(), previous_filename: v.optional(v.string()) })
);

export const gitHubInstallationSchema = v.object({ id: githubId, app_id: githubId });

export type GitHubInstallation = v.InferOutput<typeof gitHubInstallationSchema>;

export const gitHubInstallationTokenSchema = v.object({
  token: v.pipe(v.string(), v.nonEmpty()),
  expires_at: v.string(),
});

export type GitHubInstallationToken = v.InferOutput<typeof gitHubInstallationTokenSchema>;

export const gitHubInstallationReposResponseSchema = v.object({
  total_count: count,
  repositories: v.array(gitHubRepositorySchema),
});

export type GitHubInstallationReposResponse = v.InferOutput<typeof gitHubInstallationReposResponseSchema>;

export const gitHubWorkflowRunSchema = v.object({
  id: githubId,
  name: v.string(),
  status: v.string(),
  actor: v.object({ login: v.string() }),
}) satisfies v.GenericSchema<unknown, GitHubWorkflowRun>;

export const gitHubWorkflowRunsResponseSchema = v.object({
  total_count: count,
  workflow_runs: v.array(gitHubWorkflowRunSchema),
});

export type GitHubWorkflowRunsResponse = v.InferOutput<typeof gitHubWorkflowRunsResponseSchema>;

export const gitHubEffectiveBranchRuleSchema = v.object({ type: v.string(), parameters: v.optional(v.unknown()) });

export const gitHubEffectiveBranchRulesSchema = v.array(gitHubEffectiveBranchRuleSchema);

export const gitHubRequiredStatusChecksParametersSchema = v.object({
  required_status_checks: v.array(
    v.object({ context: v.pipe(v.string(), v.nonEmpty()), integration_id: v.nullish(githubId) })
  ),
  strict_required_status_checks_policy: v.boolean(),
});

export const toGitHubRequiredStatusChecks = (rules: v.InferOutput<typeof gitHubEffectiveBranchRulesSchema>) => {
  const requiredChecks: GitHubRequiredStatusCheck[] = [];
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    const parameters = v.safeParse(gitHubRequiredStatusChecksParametersSchema, rule.parameters);
    if (!parameters.success) return parameters;
    for (const check of parameters.output.required_status_checks) {
      requiredChecks.push({ context: check.context, integrationId: check.integration_id ?? null });
    }
  }
  return { success: true as const, data: requiredChecks };
};
