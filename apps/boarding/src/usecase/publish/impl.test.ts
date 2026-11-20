import { describe, expect, it, vi } from "vitest";

import { PublishUseCaseImpl } from "./impl.js";
import { interventionLabel } from "../../domain/management.js";
import { consentLabels, mergeLabel } from "../../domain/merge-request.js";
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
  isCrossRepository: false,
  headRepositoryId: 1,
  baseRoots: ["alice"],
};
const facts = { authorRoots: ["alice"], otherPaths: [], invalidCommits: [] };
const setup = () => {
  const evaluate = vi.fn().mockResolvedValue({ status: "allowed", reason: "AUTHORIZED", facts });
  const workflowExecute = vi.fn().mockResolvedValue(undefined);
  const dependencies: PublishDependencies = {
    workflow: { execute: workflowExecute },
    botUserId: 10,
    appId: 20,
    managementBodyVersions: vi
      .fn()
      .mockImplementation(({ body }: { body: string }) => Promise.resolve([{ body, editorId: 1 }])),
    bodyVersions: vi.fn().mockImplementation(({ body }: { body: string }) => Promise.resolve([{ body, editorId: 1 }])),
    merge: vi.fn().mockResolvedValue("merged"),
    current: vi.fn().mockResolvedValue(current),
    pullRequest: vi.fn().mockResolvedValue(pr),
    evaluate: { execute: evaluate },
    notifyOpened: vi.fn().mockResolvedValue(undefined),
    startCheck: vi.fn().mockResolvedValue(42),
    finishCheck: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
    formatComment: vi.fn().mockReturnValue("comment"),
  };
  return { evaluate, workflowExecute, dependencies, usecase: new PublishUseCaseImpl(dependencies) };
};

describe("PublishUseCaseImpl", () => {
  it.each([
    [true, "allowed", 1],
    [false, "allowed", 0],
    [true, "error", 0],
  ] as const)("opened %s と評価状態 %s で通知を判定する", async (opened, status, count) => {
    const { usecase, dependencies, evaluate } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseRoots: [],
      files: [{ path: "authors/alice/meta.yaml" }],
    });
    evaluate.mockResolvedValue({
      status,
      reason: status === "error" ? "API_ERROR" : "AUTHORIZED",
      facts,
      rootEditors: [{ name: "alice", editors: [] }],
    });
    await usecase.execute({ number: 1, opened });
    expect(dependencies.notifyOpened).toHaveBeenCalledTimes(count);
  });

  it("評価済みの Editor から新しい著者の候補だけを通知する", async () => {
    const { usecase, dependencies, evaluate } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseRoots: ["existing"],
      files: [{ path: "authors/existing/meta.yaml" }, { path: "authors/alice/meta.yaml" }],
    });
    evaluate.mockResolvedValue({
      status: "allowed",
      reason: "AUTHORIZED",
      facts,
      rootEditors: [
        { name: "existing", editors: [{ type: "user", login: "bob" }] },
        { name: "alice", editors: [{ type: "user", login: "alice" }] },
      ],
    });

    await usecase.execute({ number: 1, opened: true });
    expect(dependencies.notifyOpened).toHaveBeenCalledWith(
      expect.objectContaining({ roots: [{ name: "alice", editors: [{ type: "user", login: "alice" }] }] })
    );
  });

  it("評価が早期に拒否された場合も新しい著者名を通知する", async () => {
    const { usecase, dependencies, evaluate } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseRoots: [],
      files: [{ path: "authors/alice/meta.yaml" }],
    });
    evaluate.mockResolvedValue({ status: "rejected", reason: "COMMIT_IDENTITY_MISMATCH", facts });

    await usecase.execute({ number: 1, opened: true });
    expect(dependencies.notifyOpened).toHaveBeenCalledWith(
      expect.objectContaining({ roots: [{ name: "alice", editors: null }] })
    );
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), { mode: "none" }, expect.anything());
  });

  it("Workflow の処理後に評価結果を通知する", async () => {
    const { usecase, dependencies, workflowExecute } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseRoots: [],
      files: [{ path: "authors/alice/meta.yaml" }],
    });

    await usecase.execute({ number: 1, opened: true });
    expect(workflowExecute.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.notifyOpened).mock.invocationCallOrder[0] ?? 0
    );
    expect(dependencies.notifyOpened).toHaveBeenCalledWith(
      expect.objectContaining({ result: { status: "allowed", reason: "AUTHORIZED", facts } })
    );
  });

  it("Workflow の処理と通知は、Merge の前に Merge 前の結果で実行する", async () => {
    const { usecase, dependencies, workflowExecute } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseRoots: [],
      files: [{ path: "authors/alice/meta.yaml" }],
      mergeData: {
        draft: false,
        body: `- [x] ${mergeLabel}`,
        ci: {
          checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } }],
          statuses: [],
        },
      },
    });
    vi.mocked(dependencies.merge).mockResolvedValue("merged");

    await usecase.execute({ number: 1, opened: true });
    const mergeOrder = vi.mocked(dependencies.merge).mock.invocationCallOrder[0] ?? 0;
    expect(dependencies.merge).toHaveBeenCalledOnce();
    expect(workflowExecute.mock.invocationCallOrder[0]).toBeLessThan(mergeOrder);
    expect(vi.mocked(dependencies.notifyOpened).mock.invocationCallOrder[0]).toBeLessThan(mergeOrder);
    expect(workflowExecute.mock.calls[0]?.[1]).not.toHaveProperty("mergeOutcome");
  });

  it("既存の著者のみの申請は通知しない", async () => {
    const { usecase, dependencies } = setup();
    await usecase.execute({ number: 1, opened: true });
    expect(dependencies.notifyOpened).not.toHaveBeenCalled();
  });

  it("Check 確定後に評価結果を Workflow の処理に渡す", async () => {
    const { usecase, dependencies, workflowExecute } = setup();
    await usecase.execute({ number: 1 });
    expect(workflowExecute).toHaveBeenCalledWith(pr, expect.objectContaining({ status: "allowed" }));
    expect(vi.mocked(dependencies.finishCheck).mock.invocationCallOrder[0]).toBeLessThan(
      workflowExecute.mock.invocationCallOrder[0] ?? 0
    );
  });

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

  it("Merge 依頼だけの場合は認可の評価後に履歴を取得する", async () => {
    const { usecase, dependencies, evaluate } = setup();
    const body = `- [x] ${mergeLabel}`;
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, mergeData: { ...pr.mergeData, body } });
    await usecase.execute({ number: 1 });
    expect(evaluate.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.bodyVersions).mock.invocationCallOrder[0] ?? 0
    );
  });

  it("管理モードと Merge のチェックがあっても履歴を一度だけ共有する", async () => {
    const { usecase, dependencies, evaluate } = setup();
    const body = `- [x] ${interventionLabel}\n- [x] ${mergeLabel}`;
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, mergeData: { ...pr.mergeData, body } });
    await usecase.execute({ number: 1 });
    expect(dependencies.managementBodyVersions).toHaveBeenCalledOnce();
    expect(dependencies.bodyVersions).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), { mode: "intervention" }, expect.anything());
  });

  describe("確認事項", () => {
    const consented = consentLabels.map((label) => `- [x] ${label}`).join("\n");
    const prWith = (body: string): PullRequestData => ({ ...pr, mergeData: { ...pr.mergeData, body } });

    it("チェックがなければ履歴を取得せず、未チェックの項目を評価に渡す", async () => {
      const { usecase, dependencies, evaluate } = setup();
      await usecase.execute({ number: 1 });
      expect(dependencies.managementBodyVersions).not.toHaveBeenCalled();
      expect(dependencies.bodyVersions).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledWith(
        expect.anything(),
        { mode: "none" },
        { state: "unchecked", missing: consentLabels }
      );
    });

    it("チェックがあれば評価の前に履歴を一度だけ取得し、チェック済みとして評価に渡す", async () => {
      const { usecase, dependencies, evaluate } = setup();
      vi.mocked(dependencies.pullRequest).mockResolvedValue(prWith(consented));
      await usecase.execute({ number: 1 });
      expect(dependencies.managementBodyVersions).toHaveBeenCalledOnce();
      expect(dependencies.bodyVersions).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledWith(expect.anything(), { mode: "none" }, { state: "agreed" });
      expect(evaluate.mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(dependencies.managementBodyVersions).mock.invocationCallOrder[0] ?? Infinity
      );
    });

    it("Merge と管理モードのチェックがあっても同じ履歴を使い、取得は一度だけにする", async () => {
      const { usecase, dependencies, evaluate } = setup();
      vi.mocked(dependencies.pullRequest).mockResolvedValue(
        prWith(`${consented}\n- [x] ${interventionLabel}\n- [x] ${mergeLabel}`)
      );
      const result = await usecase.execute({ number: 1 });
      expect(dependencies.managementBodyVersions).toHaveBeenCalledOnce();
      expect(dependencies.bodyVersions).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledWith(expect.anything(), { mode: "intervention" }, { state: "agreed" });
      expect(result.merge).toMatchObject({ request: "accepted" });
    });

    it("履歴を取得できなければチェックを確認できないものとして評価に渡す", async () => {
      const { usecase, dependencies, evaluate } = setup();
      vi.mocked(dependencies.pullRequest).mockResolvedValue(prWith(consented));
      vi.mocked(dependencies.managementBodyVersions).mockRejectedValue(new Error("unavailable"));
      await usecase.execute({ number: 1 });
      expect(dependencies.managementBodyVersions).toHaveBeenCalledOnce();
      expect(evaluate).toHaveBeenCalledWith(expect.anything(), { mode: "none" }, { state: "history_unavailable" });
    });

    it("本人以外がチェックした履歴は not_author として評価に渡す", async () => {
      const { usecase, dependencies, evaluate } = setup();
      vi.mocked(dependencies.pullRequest).mockResolvedValue(prWith(consented));
      vi.mocked(dependencies.managementBodyVersions).mockResolvedValue([{ body: consented, editorId: 2 }]);
      await usecase.execute({ number: 1 });
      expect(evaluate).toHaveBeenCalledWith(expect.anything(), { mode: "none" }, { state: "not_author" });
    });

    it("CONSENT_MISSING の PR は Approve も Merge もせず、待機の Check にする", async () => {
      const { usecase, dependencies, evaluate } = setup();
      vi.mocked(dependencies.pullRequest).mockResolvedValue(prWith(`- [x] ${mergeLabel}`));
      evaluate.mockResolvedValue({ status: "waiting", reason: "CONSENT_MISSING", facts });
      const result = await usecase.execute({ number: 1 });
      expect(result).toMatchObject({ status: "waiting", reason: "CONSENT_MISSING" });
      expect(result.merge).toMatchObject({ request: "accepted", waiting: "AUTHORIZATION" });
      expect(dependencies.approve).not.toHaveBeenCalled();
      expect(dependencies.merge).not.toHaveBeenCalled();
      expect(vi.mocked(dependencies.finishCheck).mock.calls[0]?.[0].result).toMatchObject({
        status: "waiting",
        reason: "CONSENT_MISSING",
      });
    });
  });

  it("管理モードの履歴取得に失敗しても Merge 用に再取得しない", async () => {
    const { usecase, dependencies } = setup();
    const body = `- [x] ${interventionLabel}\n- [x] ${mergeLabel}`;
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, mergeData: { ...pr.mergeData, body } });
    vi.mocked(dependencies.managementBodyVersions).mockRejectedValue(new Error("unavailable"));
    const result = await usecase.execute({ number: 1 });
    expect(dependencies.managementBodyVersions).toHaveBeenCalledOnce();
    expect(dependencies.bodyVersions).not.toHaveBeenCalled();
    expect(result.merge).toMatchObject({ request: "invalid", reason: "HISTORY_UNAVAILABLE" });
  });

  it("管理モードの履歴取得に失敗すると通常の認可に戻す", async () => {
    const { usecase, dependencies, evaluate } = setup();
    const body = `- [x] ${interventionLabel}`;
    vi.mocked(dependencies.pullRequest).mockResolvedValue({ ...pr, mergeData: { ...pr.mergeData, body } });
    vi.mocked(dependencies.managementBodyVersions).mockRejectedValue(new Error("unavailable"));
    evaluate.mockResolvedValueOnce({
      status: "allowed",
      reason: "AUTHORIZED",
      facts,
      management: { mode: "none", reason: "HISTORY_UNAVAILABLE" },
    });
    const result = await usecase.execute({ number: 1 });
    expect(evaluate).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "none", reason: "HISTORY_UNAVAILABLE" },
      expect.anything()
    );
    expect(result.management).toMatchObject({ reason: "HISTORY_UNAVAILABLE" });
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

  it.each([
    ["rejected", ["allowed:none", "allowed:rejected"]],
    ["changed", ["allowed:none", "error:changed"]],
    ["merged", ["allowed:none"]],
  ] as const)(
    "Merge の結果 %s で、Merge 済みでなければ Merge を試した後にコメントを更新する",
    async (outcome, bodies) => {
      const { usecase, dependencies } = setup();
      vi.mocked(dependencies.pullRequest).mockResolvedValue({
        ...pr,
        mergeData: {
          draft: false,
          body: "- [x] すべてのチェックが成功したら自動マージする",
          ci: {
            checks: [
              { name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } },
            ],
            statuses: [],
          },
        },
      });
      vi.mocked(dependencies.merge).mockResolvedValue(outcome);
      vi.mocked(dependencies.formatComment).mockImplementation(
        (result) => `${result.status}:${result.mergeOutcome ?? "none"}`
      );

      await usecase.execute({ number: 1 });

      expect(vi.mocked(dependencies.comment).mock.calls.map(([input]) => input.body)).toEqual(bodies);
      if (outcome !== "merged") {
        expect(vi.mocked(dependencies.comment).mock.invocationCallOrder[1]).toBeGreaterThan(
          vi.mocked(dependencies.merge).mock.invocationCallOrder[0] ?? 0
        );
      }
    }
  );

  it("Merge の拒否後のコメントの更新に失敗しても Merge の結果を返す", async () => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      mergeData: {
        draft: false,
        body: "- [x] すべてのチェックが成功したら自動マージする",
        ci: {
          checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 3, slug: "github-actions" } }],
          statuses: [],
        },
      },
    });
    vi.mocked(dependencies.merge).mockResolvedValue("rejected");
    vi.mocked(dependencies.comment).mockResolvedValueOnce().mockRejectedValueOnce(new Error("failed"));

    await expect(usecase.execute({ number: 1 })).resolves.toMatchObject({
      status: "allowed",
      mergeOutcome: "rejected",
    });
  });

  it("Merge の競合は再評価可能なエラーとして返す", async () => {
    const { usecase, dependencies } = setup();
    const body = "- [x] すべてのチェックが成功したら自動マージする";
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseRoots: [],
      files: [{ path: "authors/alice/meta.yaml" }],
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

    await expect(usecase.execute({ number: 1, opened: true })).resolves.toMatchObject({
      status: "error",
      reason: "API_ERROR",
      mergeOutcome: "changed",
    });
    expect(dependencies.merge).toHaveBeenCalledWith({ number: 1, headSha: "head" });
    expect(dependencies.notifyOpened).toHaveBeenCalledWith(
      expect.objectContaining({ result: { status: "allowed", reason: "AUTHORIZED", facts } })
    );
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

  it("Approve が成功すればコメントは 1 回だけ投稿する", async () => {
    const { usecase, dependencies } = setup();
    await usecase.execute({ number: 1 });
    expect(dependencies.comment).toHaveBeenCalledOnce();
  });

  it("Approve が失敗すればコメントをエラーの結果で更新する", async () => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.approve).mockRejectedValue(new Error("failed"));
    vi.mocked(dependencies.formatComment).mockImplementation((result) => result.status);

    await usecase.execute({ number: 1 });

    expect(vi.mocked(dependencies.comment).mock.calls.map(([input]) => input.body)).toEqual(["allowed", "error"]);
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
    expect(evaluate).toHaveBeenCalledWith(pr, { mode: "none" }, expect.anything());
    expect(dependencies.startCheck).toHaveBeenCalledWith({
      number: 1,
      baseSha: "base",
      headSha: "head",
      result: { status: "waiting", reason: "EVALUATING" },
    });
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
    expect(startOrder).toBeLessThan(commentOrder);
    expect(commentOrder).toBeLessThan(approveOrder);
    expect(approveOrder).toBeLessThan(finishOrder);
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

  it("評価情報の取得失敗を Check とコメントに出す", async () => {
    const { usecase, dependencies, workflowExecute } = setup();
    vi.mocked(dependencies.pullRequest).mockRejectedValue(new BoardingError("SUBREQUEST_LIMIT", "limit"));
    await expect(usecase.execute({ number: 1 })).resolves.toEqual({ status: "error", reason: "SUBREQUEST_LIMIT" });
    expect(dependencies.finishCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: { status: "error", reason: "SUBREQUEST_LIMIT" } })
    );
    expect(dependencies.approve).not.toHaveBeenCalled();
    expect(workflowExecute).not.toHaveBeenCalled();
  });

  it("コメントの書き込みに失敗すると成功 Check を記録しない", async () => {
    const { usecase, dependencies } = setup();
    vi.mocked(dependencies.pullRequest).mockResolvedValue({
      ...pr,
      baseRoots: [],
      files: [{ path: "authors/alice/meta.yaml" }],
    });
    vi.mocked(dependencies.comment).mockRejectedValue(new Error("failed"));
    await expect(usecase.execute({ number: 1, opened: true })).resolves.toEqual({
      status: "error",
      reason: "API_ERROR",
      facts,
    });
    expect(dependencies.finishCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: { status: "error", reason: "API_ERROR", facts } })
    );
    expect(dependencies.approve).toHaveBeenCalledOnce();
    expect(dependencies.notifyOpened).toHaveBeenCalledWith(
      expect.objectContaining({ result: { status: "allowed", reason: "AUTHORIZED", facts } })
    );
  });
});
