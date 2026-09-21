const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");

// AbortSignal.timeout() は TimeoutError、abort() は AbortError を投げる
// どちらも中断として同じに扱う
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

export const raceWithSignal = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw abortError(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Operation failed", { cause: error }));
      }
    );
  });
};

// signal の abort listener を登録してから micro-task 境界を 1 つ挟むことで、呼び出し直後に同期的に abort() された場合も検出する
export const throwIfAborted = (signal: AbortSignal): Promise<void> => raceWithSignal(Promise.resolve(), signal);
