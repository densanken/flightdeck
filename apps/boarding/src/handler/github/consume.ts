import * as v from "valibot";

import { boardingMessageSchema } from "../../message/webhook.js";

import type { BoardingMessage } from "../../message/webhook.js";
import type { FanoutUseCase } from "../../usecase/fanout/interface.js";
import type { NotificationUseCase } from "../../usecase/notification/interface.js";
import type { PublishUseCase } from "../../usecase/publish/interface.js";
import type { Logger } from "../../util/logger.js";

export interface ConsumeDependencies {
  createUseCases: (message: BoardingMessage) => {
    publish: PublishUseCase;
    fanout: FanoutUseCase;
    notification: NotificationUseCase;
  };
  logger: Logger;
}

export const createMessageConsumer =
  ({ createUseCases, logger }: ConsumeDependencies) =>
  async (message: Pick<Message, "id" | "body" | "attempts" | "ack" | "retry">): Promise<void> => {
    const parsed = v.safeParse(boardingMessageSchema, message.body);
    if (!parsed.success) {
      logger.log("error", { event: "consume", result: "invalid_message", messageId: message.id });
      message.ack();

      return;
    }

    const queued = parsed.output;
    try {
      const { publish, fanout, notification } = createUseCases(queued);
      if (queued.event === "evaluate") {
        const result = await publish.execute(queued);
        logger.log("info", {
          event: "evaluation",
          number: queued.number,
          result: result.status,
          reason: result.reason,
          mergeOutcome: result.mergeOutcome,
        });
        if (result.status === "error") throw new Error(result.reason);
      } else if (queued.event === "closed") {
        await notification.execute(queued);
      } else {
        await fanout.execute(queued);
      }

      message.ack();
    } catch (error) {
      logger.log("error", {
        event: "consume",
        result: "retry",
        messageId: message.id,
        errorMessage: error instanceof Error ? error.message : "unknown error",
      });
      message.retry();
    }
  };
