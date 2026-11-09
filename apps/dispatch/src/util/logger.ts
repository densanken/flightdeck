import { createLogger as createBaseLogger } from "@flightdeck/logger";

import type { Logger as BaseLogger } from "@flightdeck/logger";

// message は共有の logger が event 名で上書きするため、エラーの内容は errorMessage に入れる
export type LogRecord = { event: string; message?: never } & Record<string, string | number | boolean | undefined>;

export type Logger = BaseLogger<LogRecord>;

export const createLogger = createBaseLogger<LogRecord>;
