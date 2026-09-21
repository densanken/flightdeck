export type LogLevel = "debug" | "info" | "warn" | "error";

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
  retryAfter?: string;
  durationMs?: number;
  errorCode?: string;
  configKey?: string;
  configReason?: string;
  headSha?: string;
  expectedTotalCount?: number;
  observedTotalCount?: number;
}

export interface Logger {
  log(level: LogLevel, record: LogRecord): void;
}

interface LogSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const createLogger = (minimumLevel: LogLevel = "info", sink: LogSink = console): Logger => ({
  log(level, record) {
    if (priorities[level] < priorities[minimumLevel]) return;
    sink[level](JSON.stringify({ level, ...record }));
  },
});
