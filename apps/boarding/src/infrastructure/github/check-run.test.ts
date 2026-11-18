import { describe, expect, it, vi } from "vitest";

import { GitHubCheckRun } from "./check-run.js";
import { GitHubRequest } from "./request.js";

const existing = { id: 10, name: "boarding/authorization", head_sha: "abc", app: { id: 5 } };
const ref = { number: 1, baseSha: "base", headSha: "abc" };
const result = { status: "allowed", reason: "AUTHORIZED" } as const;
const setup = (runs: unknown[]) => {
  const fetcher = vi
    .fn<(input: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(Response.json({ total_count: runs.length, check_runs: runs }))
    .mockImplementationOnce((_path, init) => {
      const body = JSON.parse(init.body as string) as { status: string; conclusion?: string };
      return Promise.resolve(Response.json({ ...existing, status: body.status, conclusion: body.conclusion ?? null }));
    });
  const verify = vi.fn().mockResolvedValue(undefined);
  const check = new GitHubCheckRun({
    request: new GitHubRequest(fetcher),
    getToken: () => Promise.resolve("token"),
    appId: 5,
    verify,
  });
  return { fetcher, verify, check };
};

describe("GitHubCheckRun", () => {
  it("同じ SHA の App 自身の Check を評価中に更新する", async () => {
    const { fetcher, verify, check } = setup([existing]);
    await expect(check.start(ref)).resolves.toBe(10);
    expect(verify).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[1]?.[1].method).toBe("PATCH");
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body as string)).toMatchObject({ status: "in_progress" });
  });

  it("同じ SHA の App の Check がなければ作成する", async () => {
    const { fetcher, check } = setup([{ ...existing, app: { id: 6 } }]);
    await check.start(ref);
    expect(fetcher.mock.calls[1]?.[1].method).toBe("POST");
  });

  it("確定した Check ID を照合して一覧を取得せず更新する", async () => {
    const { fetcher, verify, check } = setup([]);
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ ...existing, status: "completed", conclusion: "success" }));
    await check.finish({ ...ref, id: 10, result });
    expect(verify).toHaveBeenCalledWith(1, "base", "abc");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1].method).toBe("PATCH");
    expect(fetcher.mock.calls[0]?.[0]).toContain("/check-runs/10");
  });

  it("waiting は in_progress にする", async () => {
    const { fetcher, check } = setup([]);
    fetcher.mockReset().mockResolvedValueOnce(Response.json({ ...existing, status: "in_progress", conclusion: null }));
    await check.finish({ ...ref, id: 10, result: { status: "waiting", reason: "EDITOR_APPROVAL_MISSING" } });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toMatchObject({ status: "in_progress" });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).not.toHaveProperty("conclusion");
  });

  it("更新後の ID または状態が異なれば失敗する", async () => {
    const { fetcher, check } = setup([]);
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ ...existing, id: 11, status: "completed", conclusion: "success" }));
    await expect(check.finish({ ...ref, id: 10, result })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("SHA が変われば結果を書き込まない", async () => {
    const { fetcher, verify, check } = setup([]);
    verify.mockRejectedValue(new Error("changed"));
    await expect(check.finish({ ...ref, id: 10, result })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
