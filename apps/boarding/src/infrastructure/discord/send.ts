import type { Logger } from "../../util/logger.js";

export class DiscordSender {
  constructor(
    private readonly input: {
      credentials: () => { token: string; channelId: string };
      webhookUrl: () => string | undefined;
      logger: Logger;
    }
  ) {}

  async send(content: string): Promise<void> {
    if (await this.sendBot(content)) return;

    const url = this.input.webhookUrl();
    if (url) await this.post(url, {}, content, "webhook");
  }

  private async sendBot(content: string): Promise<boolean> {
    try {
      const { token, channelId } = this.input.credentials();
      return await this.post(
        `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
        { Authorization: `Bot ${token}` },
        content,
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
    content: string,
    route: "bot" | "webhook"
  ): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
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
