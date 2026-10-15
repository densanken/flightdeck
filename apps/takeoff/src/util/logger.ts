import { AsyncLocalStorage } from "node:async_hooks";

import { createLogger } from "@flightdeck/logger";

import type { Logger, LogRecord } from "@flightdeck/logger";

// 同じ interaction や PR に関する log を後から絞り込めるよう、処理中の log に共通の field を付ける
const logContext = new AsyncLocalStorage<Omit<LogRecord, "event">>();

// takeoff は log level を設定で切り替えないため、module 単位の logger を全体で共有する
const baseLogger = createLogger();

export const logger: Logger = {
  log(level, record) {
    baseLogger.log(level, { ...logContext.getStore(), ...record });
  },
};

// fn の中で出す log と、fn の中で作った Promise（waitUntil の後続処理を含む）の log に fields を付ける
export const withLogContext = <T>(fields: Omit<LogRecord, "event">, fn: () => T): T =>
  logContext.run({ ...logContext.getStore(), ...fields }, fn);
