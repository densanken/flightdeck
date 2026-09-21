import type { CacheLike, CacheStorageLike } from "../repository/delivery/impl.js";
import type { Logger, LogLevel, LogRecord } from "../util/logger.js";

export class MemoryCache implements CacheLike {
  readonly entries = new Map<string, Response>();

  match(request: Request): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(request.url)?.clone());
  }

  put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
    return Promise.resolve();
  }
}

export class MemoryCacheStorage implements CacheStorageLike {
  readonly cache = new MemoryCache();
  readonly openedNames: string[] = [];

  open(cacheName: string): Promise<CacheLike> {
    this.openedNames.push(cacheName);
    return Promise.resolve(this.cache);
  }
}

export class RecordingLogger implements Logger {
  readonly records: { level: LogLevel; record: LogRecord }[] = [];

  log(level: LogLevel, record: LogRecord): void {
    this.records.push({ level, record });
  }
}
