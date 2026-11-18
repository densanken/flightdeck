import { describe, expect, it, vi } from "vitest";

import { FanoutUseCaseImpl } from "./impl.js";

import type { BoardingMessage } from "../../message/webhook.js";

describe("FanoutUseCaseImpl", () => {
  it("PR ごとの message をまとめて投入する", async () => {
    const enqueue = vi.fn<(messages: BoardingMessage[]) => Promise<void>>().mockResolvedValue(undefined);
    const usecase = new FanoutUseCaseImpl({
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

  it("権限変更では Installation を検証してから PR を列挙する", async () => {
    const verifyInstallation = vi.fn().mockRejectedValue(new Error("installation"));
    const listOpenPullRequests = vi.fn().mockResolvedValue([1]);
    const enqueue = vi.fn();
    const usecase = new FanoutUseCaseImpl({ verifyInstallation, listOpenPullRequests, enqueue });
    await expect(
      usecase.execute({ event: "permissions-changed", deliveryId: "delivery", installationId: 1 })
    ).rejects.toThrow();
    expect(listOpenPullRequests).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("PR の取得に失敗すれば投入しない", async () => {
    const enqueue = vi.fn();
    const usecase = new FanoutUseCaseImpl({
      verifyInstallation: () => Promise.resolve(),
      listOpenPullRequests: () => Promise.reject(new Error("failed")),
      enqueue,
    });
    await expect(usecase.execute({ event: "push", deliveryId: "delivery", installationId: 1 })).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
