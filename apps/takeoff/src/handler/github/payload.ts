import { z } from "zod";

export const gitHubWorkflowRunEventSchema = z.object({
  action: z.string(),
  workflow_run: z.object({
    id: z.number().int(),
    name: z.string(),
    status: z.string(),
    event: z.string(),
    actor: z.object({ login: z.string() }),
    head_repository: z.object({ full_name: z.string() }).optional(),
  }),
  repository: z.object({
    id: z.number().int(),
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export const gitHubRepositoryEventSchema = z.object({
  action: z.string(),
  repository: z.object({
    id: z.number().int(),
    name: z.string(),
    full_name: z.string(),
    html_url: z.url(),
    owner: z.object({ login: z.string() }),
  }),
});
