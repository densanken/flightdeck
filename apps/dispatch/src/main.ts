import { composeApp, composeMessageConsumer } from "./composition/app.js";

import type { Env } from "./env.js";
import type { DispatchMessage } from "./message/webhook.js";

const app = composeApp();

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<DispatchMessage>, env: Env): Promise<void> {
    const consume = composeMessageConsumer(env);

    for (const message of batch.messages) await consume(message);
  },
};
