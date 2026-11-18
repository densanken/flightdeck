import { BoardingError } from "../../errors.js";

import type { BoardingMessage } from "../../message/webhook.js";

export const createBatchEnqueue =
  (queue: Pick<Queue<BoardingMessage>, "sendBatch">) =>
  async (messages: BoardingMessage[]): Promise<void> => {
    const batchSize = 100;
    const maxBatches = 10;
    if (messages.length > batchSize * maxBatches) {
      throw new BoardingError("SUBREQUEST_LIMIT", "Queue fanout budget exceeded");
    }

    for (let index = 0; index < messages.length; index += batchSize) {
      await queue.sendBatch(messages.slice(index, index + batchSize).map((body) => ({ body })));
    }
  };
