import type { CiData } from "../../domain/merge.js";
import type { BoardingMessage } from "../../message/webhook.js";

export interface FanoutDependencies {
  verifyInstallation: () => Promise<void>;
  listOpenPullRequests: () => Promise<number[]>;
  associatedPullRequests: (sha: string, repositoryId: number) => Promise<{ numbers: number[]; ci: CiData | null }>;
  appId: number;
  enqueue: (messages: BoardingMessage[]) => Promise<void>;
}
