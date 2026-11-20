import { describe, expect, it, vi } from "vitest";

import { GitHubCheckRun } from "./check-run.js";
import { GitHubRequest } from "./request.js";

const existing = { id: 10, name: "Boarding", head_sha: "abc", app: { id: 5 } };
const ref = {
  number: 1,
  baseSha: "base",
  headSha: "abc",
  output: { title: "表示名", summary: "管理コメントを確認してください" },
};
const result = { status: "allowed", reason: "AUTHORIZED" } as const;
const setup = () => {
  const fetcher = vi
    .fn<(input: string, init: RequestInit) => Promise<Response>>()
    .mockImplementationOnce((_path, init) => {
      const body = JSON.parse(init.body as string) as { status: string; conclusion?: string };
      return Promise.resolve(Response.json({ ...existing, status: body.status, conclusion: body.conclusion ?? null }));
    });
  const verify = vi.fn().mockResolvedValue(undefined);
  const check = new GitHubCheckRun({
    request: new GitHubRequest(fetcher),
    getToken: () => Promise.resolve("token"),
    appId: 5,
    abortedOutput: { title: "中断", summary: "確認を中断しました" },
    verify,
  });
  return { fetcher, verify, check };
};

describe("GitHubCheckRun", () => {
  it("評価中は常に新しい Check を作成する", async () => {
    const { fetcher, verify, check } = setup();
    await expect(check.start({ ...ref, result: { status: "waiting", reason: "EVALUATING" } })).resolves.toBe(10);
    expect(verify).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]?.[1].method).toBe("POST");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toMatchObject({
      status: "in_progress",
      name: "Boarding",
      output: ref.output,
    });
  });

  it("確定した Check ID を照合して更新する", async () => {
    const { fetcher, verify, check } = setup();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ ...existing, status: "completed", conclusion: "success" }));
    await check.finish({ ...ref, id: 10, result });
    expect(verify).toHaveBeenCalledWith(1, "base", "abc");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1].method).toBe("PATCH");
    expect(fetcher.mock.calls[0]?.[0]).toContain("/check-runs/10");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toMatchObject({
      name: "Boarding",
      output: ref.output,
    });
  });

  it("確認に失敗したら cancelled で完了させ、元の例外を投げる", async () => {
    const { fetcher, verify, check } = setup();
    const failure = new Error("changed");
    verify.mockRejectedValue(failure);
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ ...existing, status: "completed", conclusion: "cancelled" }));
    await expect(check.finish({ ...ref, id: 10, result })).rejects.toBe(failure);
    expect(verify).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1].method).toBe("PATCH");
    expect(fetcher.mock.calls[0]?.[0]).toContain("/check-runs/10");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      output: { title: "中断", summary: "確認を中断しました" },
    });
  });

  it("cancelled の書き込みに失敗しても、元の例外を優先して投げる", async () => {
    const { fetcher, verify, check } = setup();
    const failure = new Error("changed");
    verify.mockRejectedValue(failure);
    fetcher.mockReset().mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(check.finish({ ...ref, id: 10, result })).rejects.toBe(failure);
  });

  it("Approve 待ちは action_required で完了させ、PR を詳細のリンクにする", async () => {
    const { fetcher, check } = setup();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ ...existing, status: "completed", conclusion: "action_required" }));
    await check.finish({ ...ref, id: 10, result: { status: "waiting", reason: "EDITOR_APPROVAL_MISSING" } });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      details_url: "https://github.com/densanken/blog-contents/pull/1",
    });
  });

  it("rejected は failure で完了させる", async () => {
    const { fetcher, check } = setup();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ ...existing, status: "completed", conclusion: "failure" }));
    await check.finish({ ...ref, id: 10, result: { status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" } });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("更新後の ID または状態が異なれば失敗する", async () => {
    const { fetcher, check } = setup();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json({ ...existing, id: 11, status: "completed", conclusion: "success" }));
    await expect(check.finish({ ...ref, id: 10, result })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
