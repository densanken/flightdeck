import { createLogger as createBaseLogger } from "@flightdeck/logger";

import type { Logger as BaseLogger, LogLevel } from "@flightdeck/logger";

export type { LogLevel };

// preflight の log に載せる field を固定し、field 名の誤記を型で検出する
export interface LogRecord {
  event: string;
  result?: string;
  deliveryId?: string;
  messageId?: string;
  attempts?: number;
  githubEvent?: string;
  action?: string;
  repository?: string;
  pullRequestNumber?: number;
  author?: string;
  installationId?: number;
  titleLength?: number;
  feature?: string;
  reason?: string;
  attempt?: number;
  commentCount?: number;
  commitCount?: number;
  timedOut?: boolean;
  githubStatus?: number;
  githubRequestId?: string;
  githubMessage?: string;
  acceptedPermissions?: string;
  retryAfter?: string;
  durationMs?: number;
  errorCode?: string;
  errorName?: string;
  errorLocation?: string;
  configKey?: string;
  configReason?: string;
  headSha?: string;
  expectedTotalCount?: number;
  observedTotalCount?: number;
}

export type Logger = BaseLogger<LogRecord>;

export const createLogger = createBaseLogger<LogRecord>;
