import { describe, expect, it, vi } from "vitest";

import { PublishUseCaseImpl } from "./impl.js";
import { BoardingError } from "../../errors.js";

import type { PublishDependencies } from "./dependencies.js";
import type { PullRequestData } from "../evaluate/dependencies.js";

const current = { state: "OPEN", baseBranch: "main", baseSha: "base", headSha: "head" };
const pr: PullRequestData = {
  mergeData: { draft: false, body: "", ci: null },
  ...current,
  author: { id: 1, login: "alice" },
  files: [{ path: "authors/alice/a.md" }],
  commits: [],
  reviews: [],
  baseRoots: ["alice"],
};
const facts = { authorRoots: ["alice"], otherPaths: [], invalidCommits: [] };
const setup = () => {
  const evaluate = vi.fn().mockResolvedValue({ status: "allowed", reason: "AUTHORIZED", facts });
  const dependencies: PublishDependencies = {
    botUserId: 10,
    appId: 20,
    bodyVersions: vi.fn().mockImplementation(({ body }: { body: string }) => Promise.resolve([{ body, editorId: 1 }])),
    merge: vi.fn().mockResolvedValue("merged"),
    current: vi.fn().mockResolvedValue(current),
    pullRequest: vi.fn().mockResolvedValue(pr),
    evaluate: { execute: evaluate },
    startCheck: vi.fn().mockResolvedValue(42),
    finishCheck: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
    formatComment: vi.fn().mockReturnValue("comment"),
  };
  return { evaluate, dependencies, usecase: new PublishUseCaseImpl(dependencies) };
};

describe("PublishUseCaseImpl", () => {
  it.each([
    ["MERGED", "main"],
    ["CLOSED", "main"],
    ["OPEN", "other"],
  ])("状態 %s、base %s の PR は処理しない", async (state, baseBranch) => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.current).mockResolvedValue({ ...current, state, baseBranch });

    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({ status: "not_applicable" });
    expect(dependencies.startCheck).not.toHaveBeenCalled();
    expect(dependencies.approve).not.toHaveBeenCalled();
    expect(dependencies.comment).not.toHaveBeenCalled();
    expect(dependencies.merge).not.toHaveBeenCalled();
    expect(dependencies.bodyVersions).not.toHaveBeenCalled();
  });

  it.each([
    "- [ ] すべてのチェックが成功したら自動マージする",
    "- [o] すべてのチェックが成功したら自動マージする",
    "本文のみ",
  ])("チェック済みでない本文では編集履歴を取得しない", async (body) => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, mergeData: { ...pr.mergeData, body } });

    await usecase.execute({ number: 1 });
    expect(dependencies.bodyVersions).not.toHaveBeenCalled();
  });

  it("チェック済みなら評価した本文と作成者で編集履歴を取得する", async () => {
    const { usecase, dependencies } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, mergeData: { ...pr.mergeData, body } });

    await usecase.execute({ number: 1 });
    expect(dependencies.bodyVersions).toHaveBeenCalledWith({ number: 1, body, authorId: 1 });
  });

  it("履歴の取得に失敗しても認可を維持し依頼を無効にする", async () => {
    const { usecase, dependencies } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, mergeData: { ...pr.mergeData, body } });
    vi.mocked(dependencies.bodyVersions).mockRejectedValue(new Error("too large"));

    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({
      status: "allowed",
      merge: { request: "invalid", reason: "HISTORY_UNAVAILABLE" },
    });
    expect(vi.mocked(dependencies.finishCheck).mock.calls[0]?.[0].result.status).toBe("allowed");
    expect(dependencies.merge).not.toHaveBeenCalled();
  });

  it("認可 Check の成功を確定してから評価した SHA で Merge する", async () => {
    const { usecase, dependencies } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    const value: PullRequestData = {
      ...pr,
      reviews: [
        {
          reviewerId: 10,
          login: "app[bot]",
          isBot: true,
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
          commitSha: "head",
        },
      ],
      mergeData: {
        draft: false,
        body,
        ci: {
          checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } }],
          statuses: [],
        },
      },
    };
    vi.mocked(dependencies.pullRequest).mockResolvedValue(value);
    await usecase.execute({ number: 1 });
    expect(dependencies.merge).toHaveBeenCalledWith({
      number: 1,
      headSha: "head",
    });
    expect(vi.mocked(dependencies.finishCheck).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.merge).mock.invocationCallOrder[0] ?? 0
    );
  });

  it("今回の Approve が成功すれば Merge し、結果を返す", async () => {
    const { usecase, dependencies } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      mergeData: {
        draft: false,
        body,
        ci: {
          checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } }],
          statuses: [],
        },
      },
    });
    vi.mocked(dependencies.merge).mockResolvedValue("rejected");

    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({
      status: "allowed",
      mergeOutcome: "rejected",
    });
    expect(dependencies.approve).toHaveBeenCalledOnce();
    expect(dependencies.merge).toHaveBeenCalledWith({ number: 1, headSha: "head" });
  });

  it("Merge の競合は再評価可能なエラーとして返す", async () => {
    const { usecase, dependencies } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      mergeData: {
        draft: false,
        body,
        ci: {
          checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } }],
          statuses: [],
        },
      },
    });
    vi.mocked(dependencies.merge).mockResolvedValue("changed");

    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({
      status: "error",
      reason: "API_ERROR",
      mergeOutcome: "changed",
    });
    expect(dependencies.merge).toHaveBeenCalledWith({ number: 1, headSha: "head" });
  });

  it("今回の Approve が失敗すれば Merge しない", async () => {
    const { usecase, dependencies } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      mergeData: {
        draft: false,
        body,
        ci: {
          checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } }],
          statuses: [],
        },
      },
    });
    vi.mocked(dependencies.approve).mockRejectedValue(new Error("failed"));

    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({ status: "error" });
    expect(dependencies.approve).toHaveBeenCalledOnce();
    expect(dependencies.merge).not.toHaveBeenCalled();
  });

  it("認可待機なら Merge を実行しない", async () => {
    const { usecase, dependencies, evaluate } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      mergeData: {
        draft: false,
        body,
        ci: {
          checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } }],
          statuses: [],
        },
      },
    });
    evaluate.mockResolvedValue({ status: "waiting", reason: "EDITOR_APPROVAL_MISSING", facts });

    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({
      merge: { request: "accepted", waiting: "AUTHORIZATION" },
    });
    expect(dependencies.merge).not.toHaveBeenCalled();
  });

  it("評価中に Check を保留し認可成功後に Approve と成功を記録する", async () => {
    const { usecase, dependencies, evaluate } = setup();
    await expect(usecase.execute({ number: 1 })).resolves.toEqual({
      status: "allowed",
      reason: "AUTHORIZED",
      facts,
      merge: { request: "none" },
    });
    expect(evaluate).toHaveBeenCalledWith(pr);
    expect(dependencies.startCheck).toHaveBeenCalledWith({ number: 1, baseSha: "base", headSha: "head" });
    expect(dependencies.approve).toHaveBeenCalledOnce();
    expect(dependencies.finishCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        result: { status: "allowed", reason: "AUTHORIZED", facts, merge: { request: "none" } },
      })
    );
    const startOrder = vi.mocked(dependencies.startCheck).mock.invocationCallOrder[0] ?? 0;
    const approveOrder = vi.mocked(dependencies.approve).mock.invocationCallOrder[0] ?? 0;
    const commentOrder = vi.mocked(dependencies.comment).mock.invocationCallOrder[0] ?? 0;
    const finishOrder = vi.mocked(dependencies.finishCheck).mock.invocationCallOrder[0] ?? 0;
    expect(startOrder).toBeLessThan(approveOrder);
    expect(approveOrder).toBeLessThan(commentOrder);
    expect(commentOrder).toBeLessThan(finishOrder);
  });

  it.each(["headSha", "baseSha"] as const)("取得時に %s が変化したら成功や承認を書き込まない", async (key) => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, [key]: "new" });
    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({ status: "error" });
    expect(dependencies.approve).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.finishCheck).mock.calls.map(([input]) => input.result.status)).not.toContain(
      "allowed"
    );
  });

  it("SHA が書き込み前に変われば成功を書き込まない", async () => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.approve).mockRejectedValue(new Error("changed"));
    vi.mocked(dependencies.comment).mockRejectedValue(new Error("changed"));
    vi.mocked(dependencies.finishCheck).mockRejectedValueOnce(new Error("changed"));
    await expect(usecase.execute({ number: 1 })).rejects.toThrow("changed");
    expect(dependencies.finishCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 42, result: { status: "error", reason: "API_ERROR", facts } })
    );
  });

  it.each([
    ["同じ HEAD の承認", "APPROVED", "head", false],
    ["古い HEAD の承認", "APPROVED", "old", true],
    ["取り消された承認", "DISMISSED", "head", true],
  ] as const)("App の%sを判定する", async (_name, state, commitSha, shouldApprove) => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      reviews: [
        { reviewerId: 10, login: "app[bot]", isBot: true, state, submittedAt: "2026-01-01T00:00:00Z", commitSha },
      ],
    });
    await usecase.execute({ number: 1 });
    expect(vi.mocked(dependencies.approve).mock.calls).toHaveLength(shouldApprove ? 1 : 0);
  });

  it("base の著者名との衝突で拒否された PR は Approve しない", async () => {
    const { usecase, dependencies, evaluate } = setup();
    evaluate.mockResolvedValue({ status: "rejected", reason: "AUTHOR_ROOT_CASE_CONFLICT" });
    await expect(usecase.execute({ number: 1 })).resolves.toEqual({
      status: "rejected",
      reason: "AUTHOR_ROOT_CASE_CONFLICT",
      merge: { request: "none" },
    });
    expect(dependencies.approve).not.toHaveBeenCalled();
  });

  it("base 更新後に大文字小文字の衝突で拒否された場合は再承認しない", async () => {
    const { usecase, dependencies, evaluate } = setup();
    await usecase.execute({ number: 1 });
    vi.mocked(dependencies.current).mockResolvedValue({ ...current, baseSha: "new-base" });
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseSha: "new-base",
      files: [{ path: "authors/Foo/post.md" }],
      baseRoots: ["foo"],
    });
    evaluate.mockResolvedValue({ status: "rejected", reason: "AUTHOR_ROOT_CASE_CONFLICT" });
    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({
      status: "rejected",
      reason: "AUTHOR_ROOT_CASE_CONFLICT",
    });
    expect(dependencies.approve).toHaveBeenCalledTimes(1);
  });

  it("authors 以外を含む PR は Approve しない", async () => {
    const { usecase, dependencies, evaluate } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, files: [{ path: "scripts/x" }] });
    evaluate.mockResolvedValue({
      status: "allowed",
      reason: "AUTHORIZED",
      facts: { ...facts, otherPaths: ["scripts/x"] },
    });
    await usecase.execute({ number: 1 });
    expect(dependencies.approve).not.toHaveBeenCalled();
  });

  it("著者の変更と設定が混在する認可済み PR は Approve しない", async () => {
    const { usecase, dependencies, evaluate } = setup();
    evaluate.mockResolvedValue({
      status: "allowed",
      reason: "AUTHORIZED",
      facts: { ...facts, otherPaths: ["scripts/x"] },
    });
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      files: [{ path: "authors/alice/a.md" }, { path: "scripts/x" }],
    });
    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({ status: "allowed", reason: "AUTHORIZED" });
    expect(dependencies.approve).not.toHaveBeenCalled();
  });

  it("評価情報の取得失敗を Check とコメントに出す", async () => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.pullRequest).mockRejectedValue(new BoardingError("SUBREQUEST_LIMIT", "limit"));
    await expect(usecase.execute({ number: 1 })).resolves.toEqual({ status: "error", reason: "SUBREQUEST_LIMIT" });
    expect(dependencies.finishCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: { status: "error", reason: "SUBREQUEST_LIMIT" } })
    );
    expect(dependencies.approve).not.toHaveBeenCalled();
  });

  it("コメントの書き込みに失敗すると成功 Check を記録しない", async () => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.comment).mockRejectedValue(new Error("failed"));
    await expect(usecase.execute({ number: 1 })).resolves.toEqual({ status: "error", reason: "API_ERROR", facts });
    expect(dependencies.finishCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: { status: "error", reason: "API_ERROR", facts } })
    );
    expect(dependencies.approve).toHaveBeenCalledOnce();
  });
});
