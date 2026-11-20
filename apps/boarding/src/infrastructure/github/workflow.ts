import { githubId } from "@flightdeck/validation";
import * as v from "valibot";

import { GitHubHttpError } from "./request.js";
import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { WorkflowRun } from "../../domain/workflow.js";
import type { Logger } from "../../util/logger.js";

const schema = v.object({
  total_count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  workflow_runs: v.array(
    v.object({
      id: githubId,
      path: v.string(),
      event: v.string(),
      head_sha: v.string(),
      head_repository: v.nullable(v.object({ id: githubId })),
      status: v.string(),
      conclusion: v.nullable(v.string()),
      actor: v.nullable(v.object({ id: githubId })),
    })
  ),
});

export class GitHubWorkflow {
  constructor(private readonly input: { request: GitHubRequest; getToken: () => Promise<string>; logger: Logger }) {}

  async list(headSha: string): Promise<WorkflowRun[]> {
    if (!this.input.request.canSpend(2)) {
      this.input.logger.log("warn", { event: "workflow_approval_skipped", reason: "SUBREQUEST_LIMIT", headSha });
      return [];
    }

    const token = await this.input.getToken();
    const response = await this.input.request.call({
      method: "GET",
      path: `/repos/densanken/blog-contents/actions/runs?head_sha=${encodeURIComponent(headSha)}&event=pull_request&status=action_required&per_page=100`,
      token,
    });
    const parsed = v.safeParse(schema, response);
    if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "GitHub workflow runs are invalid");
    if (parsed.output.total_count !== parsed.output.workflow_runs.length) {
      this.input.logger.log("warn", {
        event: "workflow_approval_skipped",
        reason: "INCOMPLETE_RUNS",
        headSha,
        totalCount: parsed.output.total_count,
        count: parsed.output.workflow_runs.length,
      });
      return [];
    }

    return parsed.output.workflow_runs.map((run) => ({
      id: run.id,
      path: run.path,
      event: run.event,
      headSha: run.head_sha,
      headRepositoryId: run.head_repository?.id ?? null,
      status: run.status,
      conclusion: run.conclusion,
      actorId: run.actor?.id ?? null,
    }));
  }

  async approve(runs: WorkflowRun[]): Promise<void> {
    if (!this.input.request.canSpend(runs.length)) {
      this.input.logger.log("warn", {
        event: "workflow_approval_skipped",
        reason: "SUBREQUEST_LIMIT",
        runIds: runs.map((run) => run.id).join(","),
      });
      return;
    }

    const token = await this.input.getToken();
    for (const run of runs) {
      try {
        await this.input.request.call({
          method: "POST",
          path: `/repos/densanken/blog-contents/actions/runs/${String(run.id)}/approve`,
          token,
          allowEmpty: true,
        });
      } catch (error) {
        if (error instanceof GitHubHttpError && !error.rateLimited && [403, 404, 409, 422].includes(error.status)) {
          this.input.logger.log("warn", { event: "workflow_approval_rejected", runId: run.id, status: error.status });
          continue;
        }

        throw error;
      }
    }
  }
}
