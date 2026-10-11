import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatusUsecaseImpl } from "./impl.js";
import { AppError } from "../../domain/errors.js";
import { MockRegisteredRepositoryStore } from "../../repository/kv/impl.mock.js";
import { MockGitHubClient } from "../github.mock.js";

import type { StatusUsecaseParams } from "./interface.js";
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
  head: { sha: "abc123", ref: "feature-branch" },
  base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
  user: { login: "alice" },
  updated_at: "2024-01-01T00:00:00Z",
};

const defaultParams: StatusUsecaseParams = {
  repoId: "101",
  prNumber: 42,
};

let githubClient: MockGitHubClient;
let repoStore: MockRegisteredRepositoryStore;
let autoApproveUsecase: AutoApproveUsecase;

beforeEach(async () => {
  vi.clearAllMocks();
  githubClient = new MockGitHubClient();
  repoStore = new MockRegisteredRepositoryStore();
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

  mockApproveActionRequiredRuns.mockResolvedValue({ approved: [], awaitingApproval: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tokenProvider = { getToken: () => Promise.resolve("token") };

const createUsecase = () => new StatusUsecaseImpl(githubClient, tokenProvider, repoStore, autoApproveUsecase);

describe("StatusUsecaseImpl", () => {
  describe("merge が可能なケース", () => {
    it("canMerge: true の結果を返す", async () => {
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(true);
      expect(result.pr.number).toBe(42);
      expect(result.repo.repoId).toBe("101");
    });
  });

  describe("merge が不可のケース", () => {
    it("PR が open でないとき canMerge: false を返す", async () => {
      githubClient.pullRequests = [{ ...testPr, state: "closed" }];
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("pr_not_open");
      }
    });

    it("PR が draft のとき canMerge: false を返す", async () => {
      githubClient.pullRequests = [{ ...testPr, draft: true }];
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("pr_is_draft");
      }
    });

    it("check run が失敗しているとき canMerge: false を返す", async () => {
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

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("checks_failed");
      }
    });

    it("combined status が pending のとき canMerge: false を返す", async () => {
      githubClient.combinedStatus = {
        state: "pending",
        total_count: 1,
        statuses: [{ state: "pending", context: "ci/test", target_url: null }],
      };
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("statuses_pending");
      }
    });

    it("required status checks rule がなければ fail-closed にする", async () => {
      githubClient.requiredStatusChecks = [];
      const result = await createUsecase().getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("required_checks_policy_missing");
      }
    });

    it("required check が未発火なら fail-closed にする", async () => {
      githubClient.checkRuns = { total_count: 0, check_runs: [] };
      const result = await createUsecase().getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("required_checks_missing");
      }
    });

    it("Rules API の取得に失敗したら結果を返さず fail-closed にする", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(new Error("rules unavailable"));

      await expect(createUsecase().getStatus(defaultParams)).rejects.toThrow("rules unavailable");
    });

    it("Rules API が GitHub plan 制限でも GHA check が通れば merge 可にする", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(
        new AppError("github_rules_api_unavailable", "Rules API unavailable")
      );

      const result = await createUsecase().getStatus(defaultParams);

      expect(result.gateResult).toEqual({ canMerge: true, headSha: "abc123" });
    });

    it("Rules API が使えないとき bot の check が成功していても GHA 0 件なら merge 不可にする", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(
        new AppError("github_rules_api_unavailable", "Rules API unavailable")
      );
      githubClient.checkRuns.check_runs[0] = {
        id: 1,
        name: "CI",
        status: "completed",
        conclusion: "success",
        html_url: null,
        app: { id: 123, slug: "example-bot" },
      };

      const result = await createUsecase().getStatus(defaultParams);

      expect(result.gateResult).toMatchObject({ canMerge: false, error: { type: "checks_not_registered" } });
    });

    it("Rules API が使えず check run と status が未登録なら merge 不可にする", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(
        new AppError("github_rules_api_unavailable", "Rules API unavailable")
      );
      githubClient.checkRuns = { total_count: 0, check_runs: [] };
      githubClient.combinedStatus = { state: "pending", total_count: 0, statuses: [] };

      const result = await createUsecase().getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) expect(result.gateResult.error.type).toBe("checks_not_registered");
    });

    it("Rules API が GitHub plan 制限でも失敗した check は fail-closed にする", async () => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(
        new AppError("github_rules_api_unavailable", "Rules API unavailable")
      );
      githubClient.checkRuns.check_runs[0] = {
        id: 1,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        html_url: null,
        app: { id: 123 },
      };

      const result = await createUsecase().getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) expect(result.gateResult.error.type).toBe("checks_failed");
    });

    it.each([
      [{ state: "closed" }, "pr_not_open"],
      [{ draft: true }, "pr_is_draft"],
      [{ title: "invalid title" }, "invalid_pr_title"],
      [{ mergeable: false }, "merge_conflict"],
    ] as const)("Rules API の plan 制限でも PR gate %j を %s で維持する", async (patch, expectedType) => {
      vi.spyOn(githubClient, "getRequiredStatusChecksForBranch").mockRejectedValue(
        new AppError("github_rules_api_unavailable", "Rules API unavailable")
      );
      githubClient.pullRequests = [{ ...testPr, ...patch }];

      const result = await createUsecase().getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) expect(result.gateResult.error.type).toBe(expectedType);
    });
  });

  describe("auto-approve が発動するケース", () => {
    it("承認直後は check が緑でも merge 可とせず CI 実行待ちを返す", async () => {
      // 承認した run はまだ check runs に現れていない（check 0 件 = 判定上は通過）状況を再現する
      mockApproveActionRequiredRuns.mockResolvedValue({
        approved: [{ runId: 100, name: "CI", actorLogin: "alice" }],
        awaitingApproval: 0,
      });
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("checks_pending");
      }
    });

    it("承認が無ければ判定結果をそのまま返す", async () => {
      mockApproveActionRequiredRuns.mockResolvedValue({ approved: [], awaitingApproval: 0 });
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(true);
    });

    it("承認待ち run のみ（approved 空・awaitingApproval>0）のとき merge 不可（runs_awaiting_approval）を返す", async () => {
      // 承認できない action_required run（非メンバー fork PR）が残るとき、/status も /merge と同様に
      // merge 不可として扱い、理由は「承認待ちで CI が未実行」を伝える runs_awaiting_approval とする
      mockApproveActionRequiredRuns.mockResolvedValue({ approved: [], awaitingApproval: 1 });
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("runs_awaiting_approval");
      }
    });

    it("approved と awaitingApproval が両方あるとき checks_pending を優先する", async () => {
      // /merge が approved を優先して auto_approved を返すのと同じく、status も承認済み run の
      // CI 実行待ち（checks_pending）を優先し、awaitingApproval はその後に評価する
      mockApproveActionRequiredRuns.mockResolvedValue({
        approved: [{ runId: 100, name: "CI", actorLogin: "alice" }],
        awaitingApproval: 1,
      });
      const usecase = createUsecase();

      const result = await usecase.getStatus(defaultParams);

      expect(result.gateResult.canMerge).toBe(false);
      if (!result.gateResult.canMerge) {
        expect(result.gateResult.error.type).toBe("checks_pending");
      }
    });

    it("注入した auto-approve usecase で対象 head SHA の run を approve する", async () => {
      mockApproveActionRequiredRuns.mockResolvedValue({ approved: [], awaitingApproval: 0 });
      const usecase = createUsecase();

      await usecase.getStatus(defaultParams);

      expect(mockApproveActionRequiredRuns).toHaveBeenCalledWith("token", "org", "repo", "abc123");
    });

    it("approve mutation が失敗したら fail-closed にする", async () => {
      mockApproveActionRequiredRuns.mockRejectedValue(new Error("approve failed"));
      const usecase = createUsecase();

      await expect(usecase.getStatus(defaultParams)).rejects.toThrow("approve failed");
    });
  });

  describe("未登録リポジトリのケース", () => {
    it("登録されていない repoId でエラーを投げる", async () => {
      const usecase = createUsecase();
      const params = { ...defaultParams, repoId: "unknown-repo" };

      await expect(usecase.getStatus(params)).rejects.toThrow(AppError);
    });

    it("repo_not_registered エラーを投げる", async () => {
      const usecase = createUsecase();
      const params = { ...defaultParams, repoId: "unknown-repo" };

      await expect(usecase.getStatus(params)).rejects.toThrow("Repository not registered");
    });

    it("登録名の PR が別 ID のリポジトリに属する場合は承認せず repo_mismatch で reject する", async () => {
      githubClient.pullRequests = [{ ...testPr, base: { ...testPr.base, repo: { id: 202 } } }];

      await expect(createUsecase().getStatus(defaultParams)).rejects.toMatchObject({ type: "repo_mismatch" });

      expect(mockApproveActionRequiredRuns).not.toHaveBeenCalled();
    });
  });
});
