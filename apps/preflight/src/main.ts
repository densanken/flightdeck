import { composeApp, composeGitHubWebhookProcessor } from "./composition/app.js";
import { getRuntimeOptions } from "./env.js";
import { ConfigurationError } from "./errors.js";
import { parseGitHubWebhookQueueMessage, parseQueuedWebhookPayload } from "./handler/github/webhook-queue.js";
import { createLogger } from "./util/logger.js";

import type { Env } from "./env.js";
import type { GitHubWebhookQueueMessage } from "./message/github-webhook.js";
import type { Logger } from "./util/logger.js";

const app = composeApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async queue(batch: MessageBatch<GitHubWebhookQueueMessage>, env: Env): Promise<void> {
    let logger: Logger;
    let processor: ReturnType<typeof composeGitHubWebhookProcessor>;
    try {
      const runtimeOptions = getRuntimeOptions(env);
      logger = createLogger(runtimeOptions.logLevel);
      // 通常処理と fail-closed の deadline は handler の既定値を使う
      processor = composeGitHubWebhookProcessor(env, { logger }, runtimeOptions);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      const defaultLogger = createLogger("info");
      for (const message of batch.messages) {
        defaultLogger.log("error", {
          event: "github_webhook_consume",
          result: "retry",
          messageId: message.id,
          attempts: message.attempts,
          errorCode: error.code,
          configKey: error.configKey,
          configReason: error.reason,
        });
        message.retry();
      }
      return;
    }
    for (const message of batch.messages) {
      const queued = parseGitHubWebhookQueueMessage(message.body);
      const payload = queued ? parseQueuedWebhookPayload(queued) : null;
      // 形が壊れた message は retry しても同じ結果になるため捨てる
      if (!queued || !payload) {
        logger.log("error", { event: "github_webhook_consume", result: "invalid_message", messageId: message.id });
        message.ack();
        continue;
      }
      const retry = (errorCode: string) => {
        logger.log("error", {
          event: "github_webhook_consume",
          result: "retry",
          deliveryId: queued.deliveryId,
          messageId: message.id,
          attempts: message.attempts,
          errorCode,
        });
        message.retry();
      };
      try {
        const outcome = await processor(payload, { deliveryId: queued.deliveryId, attempt: message.attempts });
        if (outcome.status === "failed") {
          retry(outcome.errorCode);
          continue;
        }
        logger.log("info", {
          event: "github_webhook_consume",
          result: "processed",
          deliveryId: queued.deliveryId,
          messageId: message.id,
          attempts: message.attempts,
        });
        message.ack();
      } catch (error) {
        retry(error instanceof Error ? error.name : "unknown_error");
      }
    }
  },
};
