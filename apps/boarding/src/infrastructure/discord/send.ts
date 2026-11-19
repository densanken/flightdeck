import type { DiscordPayload } from "../../message/notification.js";
import type { Logger } from "../../util/logger.js";

export class DiscordSender {
  constructor(
    private readonly input: {
      credentials: () => { token: string; channelId: string };
      webhookUrl: () => string | undefined;
      logger: Logger;
    }
  ) {}

  async send(payload: DiscordPayload): Promise<void> {
    if (await this.sendBot(payload)) return;

    const url = this.input.webhookUrl();
    if (url) await this.post(url, {}, payload, "webhook");
  }

  private async sendBot(payload: DiscordPayload): Promise<boolean> {
    try {
      const { token, channelId } = this.input.credentials();
      return await this.post(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
        { Authorization: `Bot ${token}` },
        payload,
        "bot"
      );
    } catch {
      this.input.logger.log("error", { event: "notification_failed", route: "bot" });
      return false;
    }
  }

  private async post(
    url: string,
    headers: Record<string, string>,
    payload: DiscordPayload,
    route: "bot" | "webhook"
  ): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        this.input.logger.log("error", {
          event: "notification_failed",
          route,
          status: response.status,
          retryAfter: response.status === 429 ? (response.headers.get("Retry-After") ?? undefined) : undefined,
        });
      }
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      this.input.logger.log("error", { event: "notification_failed", route });
      return false;
    }
  }
}
