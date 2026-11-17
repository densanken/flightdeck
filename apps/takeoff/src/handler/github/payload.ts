import { githubId, repositoryFullName } from "@flightdeck/validation";
import * as v from "valibot";

export const gitHubWorkflowRunEventSchema = v.object({
  action: v.string(),
  workflow_run: v.object({
    id: githubId,
    name: v.string(),
    status: v.string(),
    event: v.string(),
    actor: v.object({ login: v.string() }),
    head_repository: v.optional(v.object({ full_name: repositoryFullName })),
  }),
  repository: v.object({
    id: githubId,
    name: v.string(),
    full_name: repositoryFullName,
    owner: v.object({ login: v.string() }),
  }),
});

export const gitHubRepositoryEventSchema = v.object({
  action: v.string(),
  repository: v.object({
    id: githubId,
    name: v.string(),
    full_name: repositoryFullName,
    html_url: v.pipe(v.string(), v.url()),
    owner: v.object({ login: v.string() }),
  }),
});
