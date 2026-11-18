import { describe, expect, it, vi } from "vitest";

import { GitHubRequest } from "./request.js";
import { GitHubWorkflow } from "./workflow.js";

const run = {
  id: 1,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  headSha: "sha",
  headRepositoryId: 2,
  status: "completed",
  conclusion: "action_required",
  actorId: 3,
};
const responseRun = {
  id: 1,
  path: run.path,
  event: run.event,
  head_sha: "sha",
  head_repository: { id: 2 },
  status: run.status,
  conclusion: run.conclusion,
  actor: { id: 3 },
};
const setup = (responses: Response[], limit = 35) => {
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  const logger = { log: vi.fn() };
  const request = new GitHubRequest(fetcher).withLimit(limit);
  return {
    fetcher,
    logger,
    gateway: new GitHubWorkflow({ request, getToken: () => Promise.resolve("token"), logger }),
  };
};

describe("GitHubWorkflow", () => {
  it("SHA と保留状態を指定して 1 ページ取得する", async () => {
    const { gateway, fetcher } = setup([Response.json({ total_count: 1, workflow_runs: [responseRun] })]);
    await expect(gateway.list("sha")).resolves.toEqual([run]);
    expect(fetcher.mock.calls[0]?.[0]).toContain(
      "?head_sha=sha&event=pull_request&status=action_required&per_page=100"
    );
  });

  it("件数が一致しなければ承認しない", async () => {
    const { gateway, logger } = setup([Response.json({ total_count: 2, workflow_runs: [responseRun] })]);
    await expect(gateway.list("sha")).resolves.toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        event: "workflow_approval_skipped",
        reason: "INCOMPLETE_RUNS",
        headSha: "sha",
        totalCount: 2,
        count: 1,
      })
    );
  });

  it("対象 Run を承認する", async () => {
    const { gateway, fetcher } = setup([new Response(null, { status: 201 })]);
    await gateway.approve([run]);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/actions/runs/1/approve");
    expect(fetcher.mock.calls[0]?.[1].method).toBe("POST");
  });

  it.each([403, 404, 409, 422])("拒否 %i を記録する", async (status) => {
    const { gateway, logger } = setup([new Response(null, { status })]);
    await expect(gateway.approve([run])).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith("warn", expect.objectContaining({ status }));
  });

  it("拒否以外の失敗は例外を投げる", async () => {
    await expect(setup([new Response(null, { status: 500 })]).gateway.approve([run])).rejects.toThrow();
  });

  it("一覧取得後の残予算と承認件数が一致すれば承認する", async () => {
    const { gateway, fetcher } = setup(
      [Response.json({ total_count: 1, workflow_runs: [responseRun] }), new Response(null, { status: 201 })],
      2
    );
    const runs = await gateway.list("sha");
    await gateway.approve(runs);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1].method).toBe("POST");
  });

  it("一覧取得後の残予算が承認件数に足りなければ承認しない", async () => {
    const { gateway, fetcher, logger } = setup(
      [Response.json({ total_count: 2, workflow_runs: [responseRun, { ...responseRun, id: 2 }] })],
      2
    );
    const runs = await gateway.list("sha");
    await gateway.approve(runs);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "workflow_approval_skipped", reason: "SUBREQUEST_LIMIT", runIds: "1,2" })
    );
  });

  it("照会と承認の予算がなければ取得しない", async () => {
    const { gateway, fetcher, logger } = setup([], 1);
    await expect(gateway.list("sha")).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "workflow_approval_skipped", reason: "SUBREQUEST_LIMIT", headSha: "sha" })
    );
  });
});
