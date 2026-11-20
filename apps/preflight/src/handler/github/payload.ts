import { commitSha, githubId, repositoryFullName } from "@flightdeck/validation";
import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());

const payloadSchema = v.object({
  action: v.string(),
  before: v.optional(commitSha),
  changes: v.optional(
    v.object({
      title: v.optional(v.object({ from: v.optional(v.string()) })),
      base: v.optional(v.object({ ref: v.optional(v.object({ from: v.optional(v.string()) })) })),
    })
  ),
  installation: v.object({ id: githubId }),
  repository: v.object({ full_name: repositoryFullName }),
  pull_request: v.object({
    number: githubId,
    title: v.string(),
    head: v.object({ sha: commitSha }),
    user: v.object({ login: nonEmpty, type: nonEmpty }),
    assignees: v.optional(v.array(v.object({ login: nonEmpty })), []),
  }),
});

export interface PullRequestWebhookPayload {
  action: string;
  before?: string;
  changes?: { title?: { from?: string }; base?: { ref?: { from?: string } } };
  installation: { id: number };
  repository: { fullName: string };
  pullRequest: {
    number: number;
    title: string;
    head: { sha: string };
    user: { login: string; type: string };
    assignees: { login: string }[];
  };
}

export const parsePullRequestWebhookPayload = (value: unknown): PullRequestWebhookPayload | null => {
  const parsed = v.safeParse(payloadSchema, value);
  if (!parsed.success) return null;
  const { pull_request: pullRequest, repository, ...rest } = parsed.output;
  return {
    ...rest,
    changes: rest.changes?.title === undefined && rest.changes?.base?.ref === undefined ? undefined : rest.changes,
    repository: { fullName: repository.full_name },
    pullRequest,
  };
};
