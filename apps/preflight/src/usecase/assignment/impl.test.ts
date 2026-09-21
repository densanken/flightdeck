import { describe, expect, it, vi } from "vitest";

import { AssignPullRequestAuthorUseCaseImpl } from "./impl.js";

import type { GitHubAssignmentGateway } from "./dependencies.js";
import type { AssignPullRequestAuthorCommand } from "./interface.js";

class RecordingGitHubGateway implements GitHubAssignmentGateway {
  readonly assignPullRequestAuthor = vi.fn<GitHubAssignmentGateway["assignPullRequestAuthor"]>();

  constructor(assigned = true) {
    this.assignPullRequestAuthor.mockResolvedValue(assigned);
  }
}

const command = (overrides: Partial<AssignPullRequestAuthorCommand> = {}): AssignPullRequestAuthorCommand => ({
  action: "opened",
  owner: "owner",
  repo: "repo",
  pullRequestNumber: 7,
  author: "author",
  authorType: "User",
  assignees: [],
  ...overrides,
});

const createUseCase = (input: { gateway?: RecordingGitHubGateway; skipBots?: boolean; signal?: AbortSignal } = {}) => {
  const gateway = input.gateway ?? new RecordingGitHubGateway();
  const signal = input.signal ?? new AbortController().signal;
  const useCase = new AssignPullRequestAuthorUseCaseImpl({
    githubGateway: gateway,
    skipBots: input.skipBots ?? true,
  });
  return { useCase, gateway, signal };
};

describe("AssignPullRequestAuthorUseCaseImpl", () => {
  it.each(["opened", "reopened"])("%s では作成者を assignee に追加する", async (action) => {
    const { useCase, gateway, signal } = createUseCase();

    await expect(useCase.execute(command({ action }), signal)).resolves.toEqual({ result: "assigned" });
    expect(gateway.assignPullRequestAuthor).toHaveBeenCalledWith(expect.objectContaining({ author: "author" }), signal);
  });

  it("対象外の action は何もせず ignored_action を返す", async () => {
    const { useCase, gateway, signal } = createUseCase();
    await expect(useCase.execute(command({ action: "synchronize" }), signal)).resolves.toEqual({
      result: "ignored_action",
    });
    expect(gateway.assignPullRequestAuthor).not.toHaveBeenCalled();
  });

  it.each([
    { author: "renovate", authorType: "Bot" },
    { author: "renovate[bot]", authorType: "User" },
  ])("bot の作成者を skip する", async ({ author, authorType }) => {
    const { useCase, gateway, signal } = createUseCase();
    await expect(useCase.execute(command({ author, authorType }), signal)).resolves.toEqual({
      result: "skipped_bot",
    });
    expect(gateway.assignPullRequestAuthor).not.toHaveBeenCalled();
  });

  it("skipBots が false のときは bot が作成した PR にも assign する", async () => {
    const { useCase, gateway, signal } = createUseCase({ skipBots: false });
    await expect(useCase.execute(command({ author: "renovate[bot]", authorType: "Bot" }), signal)).resolves.toEqual({
      result: "assigned",
    });
    expect(gateway.assignPullRequestAuthor).toHaveBeenCalledOnce();
  });

  it("既存 assignee を大文字小文字を無視して判定する", async () => {
    const { useCase, gateway, signal } = createUseCase();
    await expect(
      useCase.execute(command({ author: "Author", assignees: ["author", "other"] }), signal)
    ).resolves.toEqual({ result: "already_assigned" });
    expect(gateway.assignPullRequestAuthor).not.toHaveBeenCalled();
  });

  it("assign できない作成者は not_assignable として成功扱いで返す", async () => {
    const { useCase, signal } = createUseCase({ gateway: new RecordingGitHubGateway(false) });
    await expect(useCase.execute(command(), signal)).resolves.toEqual({ result: "not_assignable" });
  });

  it("gateway の失敗をそのまま伝播する", async () => {
    const gateway = new RecordingGitHubGateway();
    gateway.assignPullRequestAuthor.mockRejectedValue(new Error("failed"));
    const { useCase, signal } = createUseCase({ gateway });

    await expect(useCase.execute(command(), signal)).rejects.toThrow("failed");
  });
});
