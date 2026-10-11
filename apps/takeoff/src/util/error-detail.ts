// catch した error の型情報と message を 1 行にまとめて log へ残す
// stack trace は log の肥大化を招くため含めない
export const errorDetail = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
