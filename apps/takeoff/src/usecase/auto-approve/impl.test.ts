import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoApproveUsecaseImpl } from "./impl.js";
import { MockRegisteredRepositoryStore } from "../../repository/kv/impl.mock.js";
import { MockGitHubClient } from "../github.mock.js";

let mockClient: MockGitHubClient;
let repoStore: MockRegisteredRepositoryStore;
let getToken: ReturnType<typeof vi.fn<() => Promise<string>>>;
let usecase: AutoApproveUsecaseImpl;

beforeEach(async () => {
  mockClient = new MockGitHubClient();
  repoStore = new MockRegisteredRepositoryStore();
  await repoStore.addRepository({
    repoId: "1",
    owner: "owner",
    name: "old-name",
    fullName: "owner/old-name",
    htmlUrl: "https://github.com/owner/old-name",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  });
  getToken = vi.fn<() => Promise<string>>().mockResolvedValue("token");
  usecase = new AutoApproveUsecaseImpl(mockClient, { getToken }, repoStore, "my-org");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const runParams = (runId: number, actorLogin: string) => ({
  repoId: "1",
  owner: "owner",
  repo: "repo",
  runId,
  actorLogin,
});

describe("autoApproveByRunId", () => {
  it("org メンバーの run を承認する", async () => {
    mockClient.orgMembers.add("alice");
    const approveSpy = vi.spyOn(mockClient, "approveWorkflowRun");

    const result = await usecase.autoApproveByRunId(runParams(100, "alice"));

    expect(result).toMatchObject({ type: "evaluated", approved: true });
    // KV の登録情報ではなく引数の座標で承認する
    expect(approveSpy).toHaveBeenCalledWith("token", "owner", "repo", 100);
  });

  it("未登録 repository なら token 取得も GitHub API も呼ばない", async () => {
    const membershipSpy = vi.spyOn(mockClient, "isOrgMember");

    const result = await usecase.autoApproveByRunId({ ...runParams(100, "alice"), repoId: "999" });

    expect(result).toEqual({ type: "not_registered" });
    expect(getToken).not.toHaveBeenCalled();
    expect(membershipSpy).not.toHaveBeenCalled();
  });

  it("org メンバーでないとき approve を呼ばない", async () => {
    const spy = vi.spyOn(mockClient, "approveWorkflowRun");

    const result = await usecase.autoApproveByRunId(runParams(100, "outsider"));

    expect(result).toMatchObject({ type: "evaluated", approved: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("approve API が失敗してもエラーにならない", async () => {
    mockClient.orgMembers.add("alice");
    vi.spyOn(mockClient, "approveWorkflowRun").mockResolvedValue(false);

    const result = await usecase.autoApproveByRunId(runParams(100, "alice"));

    expect(result).toEqual({ type: "evaluated", approved: false, reason: "Run 100 could not be approved (403)" });
  });
});

describe("autoApproveByRunId - org メンバー判定", () => {
  it("メンバーのとき承認される", async () => {
    mockClient.orgMembers.add("alice");

    const result = await usecase.autoApproveByRunId(runParams(200, "alice"));

    expect(result).toMatchObject({ approved: true });
  });

  it("非メンバーのとき承認されない", async () => {
    const result = await usecase.autoApproveByRunId(runParams(200, "outsider"));

    expect(result).toMatchObject({ approved: false });
  });
});

describe("approveActionRequiredRuns", () => {
  it("action_required の run がないとき承認件数 0 を返す", async () => {
    mockClient.workflowRuns = [];

    const result = await usecase.approveActionRequiredRuns("token", "owner", "repo", "abc123");

    expect(result.approved).toHaveLength(0);
  });

  it("org メンバーの run だけを承認する", async () => {
    mockClient.orgMembers.add("alice");
    const membershipSpy = vi.spyOn(mockClient, "isOrgMember");
    const approveSpy = vi.spyOn(mockClient, "approveWorkflowRun");
    mockClient.workflowRuns = [
      { id: 1, name: "CI", status: "action_required", actor: { login: "alice" } },
      { id: 2, name: "Deploy", status: "action_required", actor: { login: "outsider" } },
      { id: 3, name: "Lint", status: "action_required", actor: { login: "alice" } },
    ];

    const result = await usecase.approveActionRequiredRuns("token", "owner", "repo", "sha123");

    expect(result.approved).toHaveLength(2);
    expect(result.approved[0]).toEqual({ runId: 1, name: "CI", actorLogin: "alice" });
    expect(result.approved[1]).toEqual({ runId: 3, name: "Lint", actorLogin: "alice" });
    expect(membershipSpy.mock.calls).toEqual([
      ["token", "my-org", "alice"],
      ["token", "my-org", "outsider"],
    ]);
    expect(approveSpy.mock.calls).toEqual([
      ["token", "owner", "repo", 1],
      ["token", "owner", "repo", 3],
    ]);
  });

  it("非メンバーの pull_request run は承認せず awaitingApproval に数える", async () => {
    mockClient.orgMembers.add("alice");
    mockClient.workflowRuns = [
      { id: 1, name: "CI", status: "action_required", actor: { login: "alice" } },
      { id: 2, name: "Deploy", status: "action_required", actor: { login: "outsider" } },
    ];

    const result = await usecase.approveActionRequiredRuns("token", "owner", "repo", "sha123");

    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]).toEqual({ runId: 1, name: "CI", actorLogin: "alice" });
    expect(result.awaitingApproval).toBe(1);
    expect(mockClient.approvedRunIds.has(2)).toBe(false);
  });

  it("メンバーでも approve が 403（false）なら承認せず awaitingApproval に数える", async () => {
    mockClient.orgMembers.add("alice");
    vi.spyOn(mockClient, "approveWorkflowRun").mockResolvedValue(false);
    mockClient.workflowRuns = [{ id: 1, name: "CI", status: "action_required", actor: { login: "alice" } }];

    const result = await usecase.approveActionRequiredRuns("token", "owner", "repo", "sha123");

    expect(result.approved).toHaveLength(0);
    expect(result.awaitingApproval).toBe(1);
  });

  it("全て承認できたとき awaitingApproval は 0 になる", async () => {
    mockClient.orgMembers.add("alice");
    mockClient.workflowRuns = [{ id: 1, name: "CI", status: "action_required", actor: { login: "alice" } }];

    const result = await usecase.approveActionRequiredRuns("token", "owner", "repo", "sha123");

    expect(result.approved).toHaveLength(1);
    expect(result.awaitingApproval).toBe(0);
  });
});

describe("approveActionRequiredRuns の失敗", () => {
  it("後続 run の membership 判定が失敗したら、先行する member run も承認しない", async () => {
    mockClient.workflowRuns = [
      { id: 1, name: "CI", status: "action_required", actor: { login: "alice" } },
      { id: 2, name: "Lint", status: "action_required", actor: { login: "bob" } },
    ];
    vi.spyOn(mockClient, "isOrgMember").mockImplementation((_token, _org, login) =>
      login === "alice" ? Promise.resolve(true) : Promise.reject(new Error("membership failed"))
    );
    const approveSpy = vi.spyOn(mockClient, "approveWorkflowRun");

    await expect(usecase.approveActionRequiredRuns("token", "owner", "repo", "sha123")).rejects.toThrow(
      "membership failed"
    );
    expect(approveSpy).not.toHaveBeenCalled();
  });
});
