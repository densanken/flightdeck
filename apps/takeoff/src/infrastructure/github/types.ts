import { z } from "zod";

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
  GitHubWorkflowRun,
} from "../../usecase/github.js";

// GitHub response の parse には schema が要るため port（usecase/github.ts）と型が二重に見えるが、
// 契約の所有者は port に一本化し、ここでは satisfies で schema の出力が port の型からずれたら compile error にする
export const gitHubRepositorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  html_url: z.url(),
  owner: z.object({
    login: z.string(),
  }),
}) satisfies z.ZodType<GitHubRepository>;

export const gitHubPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.url(),
  state: z.string(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  merge_commit_sha: z.string().nullable().optional(),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
  }),
  base: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ id: z.number().int() }),
  }),
  user: z
    .object({
      login: z.string(),
    })
    .nullable(),
  updated_at: z.iso.datetime(),
}) satisfies z.ZodType<GitHubPullRequest>;

export const gitHubPullRequestSummarySchema = gitHubPullRequestSchema.omit({
  mergeable: true,
}) satisfies z.ZodType<GitHubPullRequestSummary>;

export const gitHubCheckRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.url().nullable(),
  app: z.object({ id: z.number().int(), slug: z.string().optional() }).nullable(),
}) satisfies z.ZodType<GitHubCheckRun>;

export const gitHubCheckRunsResponseSchema = z.object({
  total_count: z.number().int(),
  check_runs: z.array(gitHubCheckRunSchema),
}) satisfies z.ZodType<GitHubCheckRunsResponse>;

export const gitHubStatusContextSchema = z.object({
  state: z.string(),
  context: z.string(),
  target_url: z.url().nullable(),
}) satisfies z.ZodType<GitHubStatusContext>;

export const gitHubCombinedStatusSchema = z.object({
  state: z.string(),
  total_count: z.number().int(),
  statuses: z.array(gitHubStatusContextSchema),
}) satisfies z.ZodType<GitHubCombinedStatus>;

export const gitHubMergeResponseSchema = z.object({
  sha: z.string(),
  merged: z.boolean(),
  message: z.string(),
}) satisfies z.ZodType<GitHubMergeResponse>;

export const gitHubInstallationSchema = z.object({
  id: z.number().int(),
  app_id: z.number().int(),
});

export type GitHubInstallation = z.infer<typeof gitHubInstallationSchema>;

export const gitHubInstallationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
});

export type GitHubInstallationToken = z.infer<typeof gitHubInstallationTokenSchema>;

export const gitHubInstallationReposResponseSchema = z.object({
  total_count: z.number().int(),
  repositories: z.array(gitHubRepositorySchema),
});

export type GitHubInstallationReposResponse = z.infer<typeof gitHubInstallationReposResponseSchema>;

export const gitHubWorkflowRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  actor: z.object({ login: z.string() }),
}) satisfies z.ZodType<GitHubWorkflowRun>;

export const gitHubWorkflowRunsResponseSchema = z.object({
  total_count: z.number().int(),
  workflow_runs: z.array(gitHubWorkflowRunSchema),
});

export type GitHubWorkflowRunsResponse = z.infer<typeof gitHubWorkflowRunsResponseSchema>;

export const gitHubEffectiveBranchRuleSchema = z.object({
  type: z.string(),
  parameters: z.unknown().optional(),
});

export const gitHubEffectiveBranchRulesSchema = z.array(gitHubEffectiveBranchRuleSchema);

export const gitHubRequiredStatusChecksParametersSchema = z.object({
  required_status_checks: z.array(
    z.object({
      context: z.string().min(1),
      integration_id: z.number().int().nullable().optional(),
    })
  ),
  strict_required_status_checks_policy: z.boolean(),
});

export const toGitHubRequiredStatusChecks = (rules: z.infer<typeof gitHubEffectiveBranchRulesSchema>) => {
  const requiredChecks: GitHubRequiredStatusCheck[] = [];
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    const parameters = gitHubRequiredStatusChecksParametersSchema.safeParse(rule.parameters);
    if (!parameters.success) return parameters;
    for (const check of parameters.data.required_status_checks) {
      requiredChecks.push({ context: check.context, integrationId: check.integration_id ?? null });
    }
  }
  return { success: true as const, data: requiredChecks };
};
