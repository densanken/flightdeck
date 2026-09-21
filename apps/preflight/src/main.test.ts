import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "./errors.js";
import worker from "./main.js";

import type { GitHubWebhookQueueMessage } from "./message/github-webhook.js";

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  log: vi.fn(),
  getRuntimeOptions: vi.fn(),
  createLogger: vi.fn(() => ({ log: vi.fn() })),
}));

vi.mock("./composition/app.js", () => ({
  composeApp: () => ({ fetch: vi.fn() }),
  composeGitHubWebhookProcessor: () => mocks.process,
}));
vi.mock("./env.js", () => ({ getRuntimeOptions: mocks.getRuntimeOptions }));
vi.mock("./util/logger.js", () => ({ createLogger: mocks.createLogger }));

const validBody = JSON.stringify({
  action: "opened",
  installation: { id: 42 },
  repository: { name: "repo", owner: { login: "owner" } },
  pull_request: {
    number: 7,
    title: "feat: add login",
    head: { sha: "abc123" },
    user: { login: "author", type: "User" },
    assignees: [],
  },
});

const message = (body: string = validBody, attempts = 1) => ({
  id: "message-1",
  timestamp: new Date(),
  body: { version: 1, event: "pull_request", deliveryId: "delivery-1", body } satisfies GitHubWebhookQueueMessage,
  attempts,
  ack: vi.fn(),
  retry: vi.fn(),
});

const consume = async (queued: ReturnType<typeof message>): Promise<void> => {
  await worker.queue({ messages: [queued] } as unknown as MessageBatch<GitHubWebhookQueueMessage>, {});
};

describe("GitHub webhook queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeOptions.mockReturnValue({ logLevel: "info" });
    mocks.createLogger.mockReturnValue({ log: mocks.log });
  });

  it("検証済み payload を processor へ渡し、処理成功を ack する", async () => {
    const success = message();
    mocks.process.mockResolvedValueOnce({ status: "processed", result: "assigned" });

    await consume(success);

    expect(mocks.process).toHaveBeenCalledWith(
      expect.objectContaining({ action: "opened", installation: { id: 42 } }),
      { deliveryId: "delivery-1", attempt: 1 }
    );
    expect(success.ack).toHaveBeenCalledOnce();
    expect(success.retry).not.toHaveBeenCalled();
  });

  it("Queue の配信回数を processor へ渡す", async () => {
    const retried = message(validBody, 3);
    mocks.process.mockResolvedValueOnce({ status: "processed", result: "assigned" });

    await consume(retried);

    expect(mocks.process).toHaveBeenCalledWith(expect.anything(), { deliveryId: "delivery-1", attempt: 3 });
  });

  it("処理失敗と想定外の例外を retry する", async () => {
    const failure = message();
    mocks.process.mockResolvedValueOnce({ status: "failed", errorCode: "GITHUB_API_FAILED" });
    await consume(failure);
    expect(failure.retry).toHaveBeenCalledOnce();
    expect(failure.ack).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ result: "retry", errorCode: "GITHUB_API_FAILED" })
    );

    const thrown = message();
    mocks.process.mockRejectedValueOnce(new Error("boom"));
    await consume(thrown);
    expect(thrown.retry).toHaveBeenCalledOnce();
    expect(thrown.ack).not.toHaveBeenCalled();
  });

  it("payload を復元できない message は retry せず ack する", async () => {
    const invalid = message("{");

    await consume(invalid);

    expect(mocks.process).not.toHaveBeenCalled();
    expect(invalid.ack).toHaveBeenCalledOnce();
    expect(invalid.retry).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("error", expect.objectContaining({ result: "invalid_message" }));
  });

  it("設定エラーを default logger で記録し、message を retry する", async () => {
    const first = message(validBody, 2);
    const second = { ...message(validBody, 4), id: "message-2" };
    mocks.getRuntimeOptions.mockImplementationOnce(() => {
      throw new ConfigurationError("LOG_LEVEL", "invalid");
    });

    await expect(
      worker.queue({ messages: [first, second] } as unknown as MessageBatch<GitHubWebhookQueueMessage>, {})
    ).resolves.toBeUndefined();

    expect(mocks.createLogger).toHaveBeenCalledOnce();
    expect(mocks.createLogger).toHaveBeenCalledWith("info");
    expect(mocks.process).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.retry).toHaveBeenCalledOnce();
    expect(second.ack).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("error", {
      event: "github_webhook_consume",
      result: "retry",
      messageId: "message-1",
      attempts: 2,
      errorCode: "INTERNAL_ERROR",
      configKey: "LOG_LEVEL",
      configReason: "invalid",
    });
  });
});
