import { DispatchError, isPermanent } from "../../errors.js";
import { dispatchMessageSchema } from "../../message/webhook.js";

import type { DispatchMessage } from "../../message/webhook.js";
import type { SyncUseCase } from "../../usecase/sync/interface.js";
import type { Logger } from "../../util/logger.js";

// wrangler.jsonc の consumer の max_retries と同じ値にする（scripts のテストで一致を確かめる）
// 初回を除いて retry がこの回数に達した後の失敗は、message が破棄される
const MAX_RETRIES = 5;

export interface ConsumeDependencies {
  // 認証 token は message ごとに作り直すため、use case は message ごとに組み立てる
  // 認証の起点は、message が運ぶ event の repository の owner と Installation の ID
  createUseCase: (message: DispatchMessage) => SyncUseCase;
  logger: Logger;
}

// ログに載せる message の内容（repository 名と branch 名だけで、Webhook の本文は含めない）
const describe = (message: DispatchMessage): Record<string, string> => {
  switch (message.event) {
    case "sync-target":
    case "close-target":
      return { source: message.source, target: message.target };
    default:
      return { repository: message.repository };
  }
};

export const createMessageConsumer =
  ({ createUseCase, logger }: ConsumeDependencies) =>
  async (message: Pick<Message, "id" | "body" | "attempts" | "ack" | "retry">): Promise<void> => {
    const parsed = dispatchMessageSchema.safeParse(message.body);
    // 形が壊れた message は retry しても同じ結果になるため捨てる
    if (!parsed.success) {
      logger.log("error", { event: "consume", result: "invalid_message", messageId: message.id });
      message.ack();

      return;
    }

    const queued = parsed.data;
    const log = {
      event: "consume",
      messageEvent: queued.event,
      ...describe(queued),
      deliveryId: queued.deliveryId,
      messageId: message.id,
      attempts: message.attempts,
    };

    try {
      const useCase = createUseCase(queued);

      switch (queued.event) {
        case "push":
          await useCase.handlePush(queued);
          break;
        case "default-branch-changed":
          await useCase.handleDefaultBranchChanged(queued);
          break;
        case "sync-target":
          await useCase.syncTarget(queued);
          break;
        case "close-target":
          await useCase.closeTarget(queued);
          break;
      }

      logger.log("info", { ...log, result: "processed" });
      message.ack();
    } catch (error) {
      // 恒久的な失敗は再実行しても同じ結果になるため、記録して捨てる
      if (isPermanent(error)) {
        logger.log("error", { ...log, result: "dropped", kind: error.kind, errorMessage: error.message });
        message.ack();

        return;
      }

      // 再実行の回数を使い切った失敗は、この後 message が破棄される（DLQ を設定していれば DLQ へ移る）
      logger.log(message.attempts > MAX_RETRIES ? "error" : "warn", {
        ...log,
        result: message.attempts > MAX_RETRIES ? "exhausted" : "retry",
        errorMessage: error instanceof Error ? error.message : "unknown error",
      });
      message.retry(error instanceof DispatchError ? { delaySeconds: error.retryAfterSeconds } : undefined);
    }
  };
