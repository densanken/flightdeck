import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MergeUsecaseImpl } from "./impl.js";
import { AppError, errors } from "../../domain/errors.js";
import { MockMergeCooldownStore } from "../../repository/cache/impl.mock.js";
import { MockRegisteredRepositoryStore } from "../../repository/kv/impl.mock.js";
import { logger } from "../../util/logger.js";
import { MockGitHubClient } from "../github.mock.js";
import { MockPullRequestUsecase } from "../pull-request/impl.mock.js";

import type { MergeAuditNotifier, MergeAuditPayload, MergeUsecaseParams } from "./interface.js";
import type { RegisteredRepository } from "../../domain/repository.js";
import type { AutoApprovePendingResult, AutoApproveUsecase } from "../auto-approve/interface.js";
import type { GitHubPullRequest } from "../github.js";

const mockApproveActionRequiredRuns =
  vi.fn<(token: string, owner: string, repo: string, headSha: string) => Promise<AutoApprovePendingResult>>();

const testRepo: RegisteredRepository = {
  repoId: "101",
  owner: "org",
  name: "repo",
  fullName: "org/repo",
  htmlUrl: "https://github.com/org/repo",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const testPr: GitHubPullRequest = {
  number: 42,
  title: "feat: add feature",
  html_url: "https://github.com/org/repo/pull/42",
  state: "open",
  draft: false,
  mergeable: true,
  head: { sha: "abc123", ref: "feature-branch", label: "org:feature-branch", repo: { id: 101 } },
  base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
  user: { login: "alice" },
  updated_at: "2024-01-01T00:00:00Z",
};

const defaultParams = (): MergeUsecaseParams => ({
  repoId: "101",
  prNumber: 42,
  discordUserId: "user-1",
  mergeDeadline: Date.now() + 19_000,
});

let githubClient: MockGitHubClient;
let repoStore: MockRegisteredRepositoryStore;
let cooldownCache: MockMergeCooldownStore;
let pullRequestUsecase: MockPullRequestUsecase;
let auditNotifier: MergeAuditNotifier;
let autoApproveUsecase: AutoApproveUsecase;
let notifyMergeAuditMock: ReturnType<typeof vi.fn<(payload: MergeAuditPayload) => Promise<void>>>;

beforeEach(async () => {
  vi.clearAllMocks();
  githubClient = new MockGitHubClient();
  repoStore = new MockRegisteredRepositoryStore();
  cooldownCache = new MockMergeCooldownStore();
  pullRequestUsecase = new MockPullRequestUsecase();
  notifyMergeAuditMock = vi.fn<(payload: MergeAuditPayload) => Promise<void>>().mockResolvedValue(undefined);
  auditNotifier = { notifyMergeAudit: notifyMergeAuditMock };
  autoApproveUsecase = {
    autoApproveByRunId: vi.fn(),
    approveActionRequiredRuns: mockApproveActionRequiredRuns,
  };

  await repoStore.addRepository(testRepo);
  githubClient.pullRequests = [testPr];
  githubClient.checkRuns = {
    total_count: 1,
    check_runs: [
      {
        id: 1,
        name: "CI",
        status: "completed",
        conclusion: "success",
        html_url: null,
        app: { id: 123, slug: "github-actions" },
      },
    ],
  };
  githubClient.combinedStatus = { state: "success", total_count: 0, statuses: [] };
  githubClient.requiredStatusChecks = [{ context: "CI", integrationId: 123 }];
  githubClient.mergeResponse = { sha: "merge-sha-123", merged: true, message: "merged" };

  mockApproveActionRequiredRuns.mockResolvedValue({ approved: [], awaitingApproval: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cooldownCache.clear();
});

const tokenProvider = { getToken: () => Promise.resolve("token") };

const createUsecase = () =>
  new MergeUsecaseImpl(
    githubClient,
    tokenProvider,
    repoStore,
    cooldownCache,
    pullRequestUsecase,
    auditNotifier,
    autoApproveUsecase
  );

describe("MergeUsecaseImpl", () => {
  describe("GitHub が権限不足として merge を拒否したケース", () => {
    const forkPr = { ...testPr, head: { ...testPr.head, label: "alice:main", repo: { id: 202 } } };

    beforeEach(() => {
      githubClient.pullRequests = [forkPr];
      vi.spyOn(githubClient, "mergePullRequest").mockRejectedValue(errors.githubAppPermissionMissing());
    });

    it("fork の workflow が base と食い違うときは追従の案内に置き換える", async () => {
      githubClient.workflowFiles.set(forkPr.base.ref, [{ path: ".github/workflows/ci.yml", sha: "new" }]);

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "fork_workflow_out_of_sync",
      });
    });

    it("PR 自体が workflow を変更しているときは、権限を持つメンバーによる merge の案内に置き換える", async () => {
      githubClient.workflowFiles.set(forkPr.head.sha, [{ path: ".github/workflows/ci.yml", sha: "changed-by-pr" }]);
      githubClient.pullRequestFilePaths = [".github/workflows/ci.yml"];

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "fork_workflow_changed",
      });
    });

    it("workflow が食い違っていなければ権限不足のまま返す", async () => {
      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "github_app_permission_missing",
      });
    });

    it("workflow の確認に失敗したときは権限不足のまま返す", async () => {
      vi.spyOn(githubClient, "listWorkflowFiles").mockRejectedValue(new Error("contents unavailable"));

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "github_app_permission_missing",
      });
    });

    it("workflow の確認が merge の期限までに終わらなければ、timeout ではなく権限不足として返す", async () => {
      vi.spyOn(githubClient, "listWorkflowFiles").mockReturnValue(new Promise(() => undefined));

      await expect(
        createUsecase().merge({ ...defaultParams(), mergeDeadline: Date.now() + 1_500 })
      ).rejects.toMatchObject({ type: "github_app_permission_missing" });
    });

    it("権限不足以外の拒否では workflow を確認しない", async () => {
      vi.spyOn(githubClient, "mergePullRequest").mockRejectedValue(errors.mergeConflict());
      const list = vi.spyOn(githubClient, "listWorkflowFiles");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({ type: "merge_conflict" });
      expect(list).not.toHaveBeenCalled();
    });

    it("同じ repository の branch からの PR では workflow を確認しない", async () => {
      githubClient.pullRequests = [testPr];
      const list = vi.spyOn(githubClient, "listWorkflowFiles");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "github_app_permission_missing",
      });
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe("正常に merge できるケース", () => {
    it("merge の成功を対象と実行者付きで記録する", async () => {
      const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
        // この test では log の出力を意図的に抑止する
      });

      const result = await createUsecase().merge(defaultParams());

      if (result.type !== "merged") throw new Error("Expected merged");
      expect(logSpy).toHaveBeenCalledWith("info", {
        event: "merge_succeeded",
        repoId: "101",
        prNumber: 42,
        commitSha: result.sha,
        discordUserId: "user-1",
      });
    });

    it("fork の head の所有者を audit 通知へ引き継ぐ", async () => {
      githubClient.pullRequests = [
        { ...testPr, head: { ...testPr.head, ref: "main", label: "alice:main", repo: { id: 202 } } },
      ];

      const result = await createUsecase().merge(defaultParams());
      if (result.type !== "merged") throw new Error("Expected merged");
      await result.afterMerge();

      expect(notifyMergeAuditMock.mock.calls[0]?.[0].pullRequest).toMatchObject({
        headRef: "alice:main",
        baseRef: "main",
      });
    });

    it("audit の停滞は merge 結果を遅らせず、後処理では cache warming も並行して試行する", async () => {
      let finishAudit: () => void = vi.fn();
      notifyMergeAuditMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishAudit = resolve;
          })
      );
      const warmSpy = vi.spyOn(pullRequestUsecase, "warmPullRequestListCache");
      vi.useFakeTimers();
      const mergedAt = new Date("2026-10-11T00:00:00Z");
      vi.setSystemTime(mergedAt);

      const result = await createUsecase().merge(defaultParams());
      expect(result.type).toBe("merged");
      expect(notifyMergeAuditMock).not.toHaveBeenCalled();
      expect(warmSpy).not.toHaveBeenCalled();
      if (result.type !== "merged") throw new Error("Expected merged");
      expect(result.mergedAt).toEqual(mergedAt);

      vi.setSystemTime(new Date(mergedAt.getTime() + 10_000));
      const afterMerge = result.afterMerge();
      expect(warmSpy).toHaveBeenCalledOnce();
      expect(notifyMergeAuditMock.mock.calls[0]?.[0].merge.mergedAt).toEqual(mergedAt);
      finishAudit();
      await afterMerge;
    });

    it("merge が成功し sha を含む結果を返す", async () => {
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());

      expect(result.type).toBe("merged");
      if (result.type === "merged") {
        expect(result.sha).toBe("merge-sha-123");
        expect(result.pr.number).toBe(42);
        expect(result.repo.repoId).toBe("101");
      }
    });

    it("再検証済み head SHA だけを指定し Discord user を GitHub merge API に渡さない", async () => {
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await createUsecase().merge(defaultParams());

      expect(mergeSpy).toHaveBeenCalledWith(
        "token",
        "org",
        "repo",
        42,
        expect.objectContaining({
          commitTitle: "feat: add feature (#42)",
          sha: "abc123",
          mergeMethod: "squash",
        })
      );
    });

    it("merge 結果を返した後、明示的な後処理で audit webhook が送信される", async () => {
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());
      expect(notifyMergeAuditMock).not.toHaveBeenCalled();
      if (result.type !== "merged") throw new Error("Expected merged");
      await result.afterMerge();

      expect(notifyMergeAuditMock).toHaveBeenCalledOnce();
      expect(notifyMergeAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          discordUserId: "user-1",
        })
      );
    });

    it("merge 後に PR リストキャッシュがウォームされる", async () => {
      const spy = vi.spyOn(pullRequestUsecase, "warmPullRequestListCache");
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());
      expect(spy).not.toHaveBeenCalled();
      if (result.type !== "merged") throw new Error("Expected merged");
      await result.afterMerge();

      expect(spy).toHaveBeenCalledOnce();
    });

    it("audit webhook 送信が失敗しても merge 結果は返る", async () => {
      const secret = "https://discord.com/api/webhooks/1/secret-token";
      const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
        // この test では log の出力を意図的に抑止する
      });
      notifyMergeAuditMock.mockRejectedValue(new Error(secret));
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());

      expect(result.type).toBe("merged");
      if (result.type !== "merged") throw new Error("Expected merged");
      await result.afterMerge();
      expect(logSpy).toHaveBeenCalledWith("error", {
        event: "merge_audit_notification_failed",
        repoId: "101",
        prNumber: 42,
        errorName: "Error",
      });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secret);
    });

    it("PR リストキャッシュウォームが失敗しても merge 結果は返る", async () => {
      vi.spyOn(pullRequestUsecase, "warmPullRequestListCache").mockRejectedValue(new Error("cache failed"));
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());

      expect(result.type).toBe("merged");
      if (result.type !== "merged") throw new Error("Expected merged");
      await expect(result.afterMerge()).resolves.toBeUndefined();
    });
  });

  describe("成功通知のための残予算", () => {
    it.each([0, 999])("mutation の残予算 %i ms ではマージせず cooldown を解除する", async (remainingMs) => {
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const params = { ...defaultParams(), mergeDeadline: Date.now() + 5_000 };
      vi.spyOn(githubClient, "getPullRequest").mockImplementation(() => {
        // 最後の PR 再取得までに予算を使い切るケースを検査する
        params.mergeDeadline = Date.now() + remainingMs;
        return Promise.resolve(testPr);
      });

      await expect(createUsecase().merge(params)).rejects.toMatchObject({ type: "invalid_request" });
      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
      expect(notifyMergeAuditMock).not.toHaveBeenCalled();
    });

    it("mutation の timeout を残予算に合わせ、期限による abort は成否確認を案内する", async () => {
      const controller = new AbortController();
      const reason = new DOMException("Time limit", "TimeoutError");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      vi.spyOn(githubClient, "mergePullRequest").mockImplementation(() => {
        controller.abort(reason);
        return Promise.reject(reason);
      });
      const mergeDeadline = Date.now() + 5_000;

      await expect(createUsecase().merge({ ...defaultParams(), mergeDeadline })).rejects.toThrow(
        "GitHub 上で PR の状態を確認"
      );
      const timeoutMs = timeoutSpy.mock.calls[0]?.[0] ?? 0;
      expect(timeoutMs).toBeGreaterThan(4_000);
      expect(timeoutMs).toBeLessThanOrEqual(5_000);
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });
  });

  describe("auto-approve が発動して早期リターンするケース", () => {
    it("承認待ち run があるとき auto_approved 結果を返す", async () => {
      mockApproveActionRequiredRuns.mockResolvedValue({
        approved: [{ runId: 100, name: "CI", actorLogin: "alice" }],
        awaitingApproval: 0,
      });
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());

      expect(result.type).toBe("auto_approved");
      if (result.type === "auto_approved") {
        expect(result.approvedRuns).toHaveLength(1);
        expect(result.approvedRuns[0]?.runId).toBe(100);
        expect(result.pr.number).toBe(42);
        expect(result.repo.repoId).toBe("101");
      }
    });

    it("auto-approve 後は merge を実行しない", async () => {
      mockApproveActionRequiredRuns.mockResolvedValue({
        approved: [{ runId: 100, name: "CI", actorLogin: "alice" }],
        awaitingApproval: 0,
      });
      const spy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await usecase.merge(defaultParams());

      expect(spy).not.toHaveBeenCalled();
    });

    it("approve mutation が失敗したら fail-closed にする", async () => {
      mockApproveActionRequiredRuns.mockRejectedValue(new Error("approve failed"));
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const cooldownSetSpy = vi.spyOn(cooldownCache, "set");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow("approve failed");
      expect(mergeSpy).not.toHaveBeenCalled();
      expect(cooldownSetSpy).not.toHaveBeenCalled();
    });
  });

  describe("承認待ち run が残る fail-closed のケース", () => {
    it("承認が 0 件で awaitingApproval が残るとき runs_awaiting_approval で reject する", async () => {
      mockApproveActionRequiredRuns.mockResolvedValue({ approved: [], awaitingApproval: 1 });
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toMatchObject({ type: "runs_awaiting_approval" });
    });

    it("fail-closed のとき merge を実行せず cooldown も set しない", async () => {
      mockApproveActionRequiredRuns.mockResolvedValue({ approved: [], awaitingApproval: 1 });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const cooldownSetSpy = vi.spyOn(cooldownCache, "set");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toMatchObject({ type: "runs_awaiting_approval" });

      expect(mergeSpy).not.toHaveBeenCalled();
      expect(cooldownSetSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("一部承認・一部待ちのときは auto_approved を先に返し throw しない", async () => {
      mockApproveActionRequiredRuns.mockResolvedValue({
        approved: [{ runId: 100, name: "CI", actorLogin: "alice" }],
        awaitingApproval: 1,
      });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());

      expect(result.type).toBe("auto_approved");
      if (result.type === "auto_approved") {
        expect(result.approvedRuns).toHaveLength(1);
      }
      expect(mergeSpy).not.toHaveBeenCalled();
    });
  });

  describe("cooldown に引っかかるケース", () => {
    it("cooldown が有効なとき mergeCooldown エラーを投げる", async () => {
      await cooldownCache.set("101", 42, {
        repoId: "101",
        prNumber: 42,
        requestedAt: "2024-01-01T00:00:00Z",
        requestedByDiscordUserId: "user-1",
      });
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow(AppError);
      await expect(usecase.merge(defaultParams())).rejects.toThrow("Merge cooldown active");
    });
  });

  describe("merge gate で弾かれるケース", () => {
    it("PR 更新から 60 秒未満なら初回 gate で止める", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:59Z"));
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "pr_recently_updated",
      });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("PR が open でないときエラーを投げる", async () => {
      githubClient.pullRequests = [{ ...testPr, state: "closed" }];
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow(AppError);
    });

    it("PR が draft のときエラーを投げる", async () => {
      githubClient.pullRequests = [{ ...testPr, draft: true }];
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow(AppError);
    });

    it("check run が失敗しているときエラーを投げる", async () => {
      githubClient.checkRuns = {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: "CI",
            status: "completed",
            conclusion: "failure",
            html_url: "https://example.com/run/1",
            app: { id: 123 },
          },
        ],
      };
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow(AppError);
    });

    it("combined status が pending のときエラーを投げる", async () => {
      githubClient.combinedStatus = {
        state: "pending",
        total_count: 1,
        statuses: [{ state: "pending", context: "ci/test", target_url: null }],
      };
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow(AppError);
    });

    it("required status checks rule がなければ merge しない", async () => {
      githubClient.requiredStatusChecks = [];
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "required_checks_policy_missing",
      });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it("Rules API の取得に失敗したら merge しない", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(new Error("rules unavailable"));
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toThrow("rules unavailable");
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it("Rules API が GitHub plan 制限で使えなくても初回と直前の全 check が通れば merge する", async () => {
      const rulesSpy = vi
        .spyOn(githubClient, "getRequiredStatusChecksForBranch")
        .mockRejectedValue(new AppError("github_rules_api_unavailable", "Rules API unavailable"));
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).resolves.toMatchObject({
        type: "merged",
        sha: "merge-sha-123",
      });
      expect(rulesSpy).toHaveBeenCalledTimes(2);
      expect(mergeSpy).toHaveBeenCalledOnce();
    });

    it("Rules API が GitHub plan 制限でも PR gate を維持して無効な title は merge しない", async () => {
      githubClient.pullRequests = [{ ...testPr, title: "invalid title" }];
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(
        new AppError("github_rules_api_unavailable", "Rules API unavailable")
      );
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({ type: "invalid_pr_title" });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it("merge gate で弾かれたとき merge を実行しない", async () => {
      githubClient.pullRequests = [{ ...testPr, state: "closed" }];
      const spy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow(AppError);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("merge 直前の再検証で弾かれるケース", () => {
    it("初回 gate 後に PR が更新されたら直前 gate で止めて cooldown を解除する", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:01:00Z"));
      const getPullRequestSpy = vi
        .spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, updated_at: "2024-01-01T00:00:01Z" });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "pr_recently_updated",
      });

      expect(getPullRequestSpy).toHaveBeenCalledTimes(2);
      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("チェック再取得中に同じ head SHA の PR が更新されたら merge 前に止める", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:02:00Z"));
      const getPullRequestSpy = vi
        .spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, updated_at: "2024-01-01T00:01:30Z" });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "pr_recently_updated",
      });

      expect(getPullRequestSpy).toHaveBeenCalledTimes(3);
      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("チェック再取得中に test merge SHA が変わったら merge 前に止める", async () => {
      const prWithMergeSha = { ...testPr, merge_commit_sha: "test-merge-sha-1" };
      vi.spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(prWithMergeSha)
        .mockResolvedValueOnce(prWithMergeSha)
        .mockResolvedValueOnce({ ...prWithMergeSha, merge_commit_sha: "test-merge-sha-2" });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "pull_request_changed",
      });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("チェック再取得中に base SHA が変わったら merge 前に止める", async () => {
      vi.spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, base: { ...testPr.base, sha: "new-base-sha" } });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "pull_request_changed",
      });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("初回 approve 後に action_required run が現れたら merge せず cooldown を解除する", async () => {
      githubClient.workflowRuns = [{ id: 100, name: "CI", status: "action_required", actor: { login: "alice" } }];
      const listSpy = vi.spyOn(githubClient, "listActionRequiredRuns");
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toMatchObject({ type: "runs_awaiting_approval" });

      expect(listSpy).toHaveBeenCalledWith("token", "org", "repo", testPr.head.sha);
      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("直前の action_required run の取得に失敗したら merge せず cooldown を解除する", async () => {
      vi.spyOn(githubClient, "listActionRequiredRuns").mockRejectedValue(new Error("list failed"));
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow("list failed");

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("再取得した PR の title が無効に変わっていたら invalid_pr_title で reject し cooldown を解除する", async () => {
      const getPullRequestSpy = vi
        .spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, title: "bad title" });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toMatchObject({ type: "invalid_pr_title" });

      expect(getPullRequestSpy).toHaveBeenCalledTimes(2);
      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("再取得した PR の mergeable が false なら merge_conflict で停止し cooldown を解除する", async () => {
      vi.spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, mergeable: false });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({ type: "merge_conflict" });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("再取得した PR の mergeable が null なら mergeability_checking で停止し cooldown を解除する", async () => {
      vi.spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, mergeable: null });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "mergeability_checking",
      });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("再取得した PR の head sha が変わっていたら head_sha_changed で reject し cooldown を解除する", async () => {
      vi.spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, head: { ...testPr.head, sha: "changed-sha" } });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toMatchObject({ type: "head_sha_changed" });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("mergePullRequest が失敗したら cooldown を解除する", async () => {
      vi.spyOn(githubClient, "mergePullRequest").mockRejectedValue(new Error("merge failed"));
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toThrow("merge failed");

      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("成功時の commitTitle は再取得後の title で組み立てる", async () => {
      vi.spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, title: "feat: renamed feature" })
        .mockResolvedValueOnce({ ...testPr, title: "feat: renamed feature" });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      const result = await usecase.merge(defaultParams());

      expect(result.type).toBe("merged");
      expect(mergeSpy).toHaveBeenCalledWith(
        "token",
        "org",
        "repo",
        42,
        expect.objectContaining({ commitTitle: "feat: renamed feature (#42)" })
      );
      if (result.type === "merged") {
        expect(result.pr.title).toBe("feat: renamed feature");
      }
    });
  });

  describe("merge 直前の checks と status の再検証で反転を捕まえるケース", () => {
    it("初回 gate は通るが再検証で check が failure に反転したら checks_failed で reject し merge せず cooldown を解除する", async () => {
      vi.spyOn(githubClient, "listCheckRunsForRef")
        .mockResolvedValueOnce({ total_count: 1, check_runs: githubClient.checkRuns.check_runs })
        .mockResolvedValueOnce({
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: "CI",
              status: "completed",
              conclusion: "failure",
              html_url: "https://example.com/run/1",
              app: { id: 123 },
            },
          ],
        });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toMatchObject({ type: "checks_failed" });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("初回 gate 後に required status checks rule が消えたら merge せず cooldown を解除する", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch")
        .mockResolvedValueOnce([{ context: "CI", integrationId: 123 }])
        .mockResolvedValueOnce([]);
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({
        type: "required_checks_policy_missing",
      });
      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("初回 gate 後の Rules API が plan 制限でも直前 check が失敗すれば merge しない", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch")
        .mockResolvedValueOnce([{ context: "CI", integrationId: 123 }])
        .mockRejectedValueOnce(new AppError("github_rules_api_unavailable", "Rules API unavailable"));
      vi.spyOn(githubClient, "listCheckRunsForRef")
        .mockResolvedValueOnce(githubClient.checkRuns)
        .mockResolvedValueOnce({
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: "CI",
              status: "completed",
              conclusion: "failure",
              html_url: null,
              app: { id: 123 },
            },
          ],
        });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({ type: "checks_failed" });
      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });

    it("初回 gate は通るが再検証で status が pending に反転したら statuses_pending で reject し merge せず cooldown を解除する", async () => {
      vi.spyOn(githubClient, "getCombinedStatusForRef")
        .mockResolvedValueOnce({ state: "success", total_count: 0, statuses: [] })
        .mockResolvedValueOnce({
          state: "pending",
          total_count: 1,
          statuses: [{ state: "pending", context: "ci/test", target_url: null }],
        });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");
      const usecase = createUsecase();

      await expect(usecase.merge(defaultParams())).rejects.toMatchObject({ type: "statuses_pending" });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });
  });

  describe("repository が見つからないケース", () => {
    it("登録されていない repoId でエラーを投げる", async () => {
      const usecase = createUsecase();
      const params = { ...defaultParams(), repoId: "unknown-repo" };

      await expect(usecase.merge(params)).rejects.toThrow(AppError);
    });

    it("登録名の PR が別 ID のリポジトリに属する場合は承認も merge もせず repo_mismatch で reject する", async () => {
      githubClient.pullRequests = [{ ...testPr, base: { ...testPr.base, repo: { id: 202 } } }];
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({ type: "repo_mismatch" });

      expect(mockApproveActionRequiredRuns).not.toHaveBeenCalled();
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it("merge 直前の再取得で PR が別 ID のリポジトリに属する場合は merge せず cooldown を解除する", async () => {
      vi.spyOn(githubClient, "getPullRequest")
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce(testPr)
        .mockResolvedValueOnce({ ...testPr, base: { ...testPr.base, repo: { id: 202 } } });
      const mergeSpy = vi.spyOn(githubClient, "mergePullRequest");

      await expect(createUsecase().merge(defaultParams())).rejects.toMatchObject({ type: "repo_mismatch" });

      expect(mergeSpy).not.toHaveBeenCalled();
      await expect(cooldownCache.get("101", 42)).resolves.toBeNull();
    });
  });
});
