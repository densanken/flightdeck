import { describe, expect, it, vi } from "vitest";

import { FanoutUseCaseImpl } from "./impl.js";

import type { BoardingMessage } from "../../message/webhook.js";

describe("FanoutUseCaseImpl", () => {
  it("PR ごとの message をまとめて投入する", async () => {
    const enqueue = vi.fn<(messages: BoardingMessage[]) => Promise<void>>().mockResolvedValue(undefined);
    const usecase = new FanoutUseCaseImpl({
      appId: 20,
      associatedPullRequests: () => Promise.resolve({ numbers: [], ci: null }),
      verifyInstallation: () => Promise.resolve(),
      listOpenPullRequests: () => Promise.resolve([2, 5]),
      enqueue,
    });

    await usecase.execute({ event: "push", deliveryId: "delivery", installationId: 1 });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith([
      { event: "evaluate", deliveryId: "delivery", installationId: 1, number: 2 },
      { event: "evaluate", deliveryId: "delivery", installationId: 1, number: 5 },
    ]);
  });

  it("CI の完了では head SHA に関連する PR のみを投入する", async () => {
    const associatedPullRequests = vi.fn().mockResolvedValue({ numbers: [3, 3], ci: null });
    const listOpenPullRequests = vi.fn();
    const enqueue = vi.fn();
    const usecase = new FanoutUseCaseImpl({
      appId: 20,
      verifyInstallation: vi.fn(),
      listOpenPullRequests,
      associatedPullRequests,
      enqueue,
    });
    await usecase.execute({
      event: "ci-completed",
      sha: "sha",
      repositoryId: 99,
      deliveryId: "delivery",
      installationId: 1,
    });
    expect(associatedPullRequests).toHaveBeenCalledWith("sha", 99);
    expect(listOpenPullRequests).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith([{ event: "evaluate", deliveryId: "delivery", installationId: 1, number: 3 }]);
  });

  it.each([
    ["未完了", "in_progress", false],
    ["完了", "completed", true],
  ])("CI が%sなら再評価の投入を判定する", async (_label, status, expected) => {
    const enqueue = vi.fn();
    const associatedPullRequests = vi.fn().mockResolvedValue({
      numbers: [3],
      ci: { checks: [{ name: "ci", status, conclusion: null, app: { id: 2 } }], statuses: [] },
    });
    const usecase = new FanoutUseCaseImpl({
      appId: 20,
      verifyInstallation: vi.fn(),
      listOpenPullRequests: vi.fn(),
      associatedPullRequests,
      enqueue,
    });

    await usecase.execute({
      event: "ci-completed",
      sha: "sha",
      repositoryId: 1,
      deliveryId: "delivery",
      installationId: 1,
    });
    expect(enqueue).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it("権限変更では Installation を検証してから PR を列挙する", async () => {
    const verifyInstallation = vi.fn().mockRejectedValue(new Error("installation"));
    const listOpenPullRequests = vi.fn().mockResolvedValue([1]);
    const enqueue = vi.fn();
    const usecase = new FanoutUseCaseImpl({
      appId: 20,
      verifyInstallation,
      listOpenPullRequests,
      associatedPullRequests: () => Promise.resolve({ numbers: [], ci: null }),
      enqueue,
    });
    await expect(
      usecase.execute({ event: "permissions-changed", deliveryId: "delivery", installationId: 1 })
    ).rejects.toThrow();
    expect(listOpenPullRequests).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("PR の取得に失敗すれば投入しない", async () => {
    const enqueue = vi.fn();
    const usecase = new FanoutUseCaseImpl({
      appId: 20,
      associatedPullRequests: () => Promise.resolve({ numbers: [], ci: null }),
      verifyInstallation: () => Promise.resolve(),
      listOpenPullRequests: () => Promise.reject(new Error("failed")),
      enqueue,
    });
    await expect(usecase.execute({ event: "push", deliveryId: "delivery", installationId: 1 })).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
