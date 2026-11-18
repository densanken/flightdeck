import type { BoardingMessage } from "../../message/webhook.js";

export interface FanoutDependencies {
  verifyInstallation: () => Promise<void>;
  listOpenPullRequests: () => Promise<number[]>;
  enqueue: (messages: BoardingMessage[]) => Promise<void>;
}
