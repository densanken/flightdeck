import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscordSender } from "./send.js";

const logger = { log: vi.fn() };
const credentials = () => ({ token: "secret-token", channelId: "123" });
const webhook = "https://discord.com/api/webhooks/123/secret-webhook";
const sender = () => new DiscordSender({ credentials, webhookUrl: () => webhook, logger });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Discord 通知", () => {
  it("Bot が成功すればメンションを無効にして送り Webhook を使わない", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await sender().send("@everyone");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/123/messages",
      expect.objectContaining({
        headers: { Authorization: "Bot secret-token", "Content-Type": "application/json" },
        body: JSON.stringify({ content: "@everyone", allowed_mentions: { parse: [] } }),
      })
    );
  });

  it.each(["応答エラー", "例外"])("Bot の%sで Webhook に同じ内容を送る", async (failure) => {
    const fetcher = vi.fn();
    if (failure === "例外") fetcher.mockRejectedValueOnce(new Error(`secret-token ${webhook}`));
    else fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await sender().send("@everyone");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      webhook,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "@everyone", allowed_mentions: { parse: [] } }),
      })
    );
    expect(logger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ event: "notification_failed", route: "bot" })
    );
  });

  it("Webhook が未設定なら Bot の失敗後に送信しない", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "12" } }));
    vi.stubGlobal("fetch", fetcher);
    await new DiscordSender({ credentials, webhookUrl: () => undefined, logger }).send("test");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ route: "bot", status: 429, retryAfter: "12" })
    );
  });

  it("Bot の設定がない場合も Webhook に送る", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await new DiscordSender({
      credentials: () => {
        throw new Error("missing");
      },
      webhookUrl: () => webhook,
      logger,
    }).send("test");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(webhook, expect.anything());
    expect(logger.log).toHaveBeenCalledWith("error", expect.objectContaining({ route: "bot" }));
  });

  it("両方の失敗と Webhook のレート制限を記録し例外を送出しない", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error(`secret-token ${webhook}`))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "5" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(sender().send("test")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ route: "webhook", status: 429, retryAfter: "5" })
    );
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("secret-token");
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(webhook);
  });

  it("Webhook の例外に含まれる秘密情報を記録しない", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockRejectedValueOnce(new Error(`${webhook} secret-token`));
    vi.stubGlobal("fetch", fetcher);
    await expect(sender().send("test")).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith("error", expect.objectContaining({ route: "webhook" }));
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(webhook);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("secret-token");
  });
});
