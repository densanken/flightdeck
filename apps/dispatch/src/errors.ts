// 分類ごとの扱い
// - retryable: GitHub の 429 や一時的な 5xx、通信失敗、CAS の不一致や parent base の変化で、Queue の retry で再実行する
// - config: YAML や path、base branch、.gitmodules の不整合で、retry しても同じ結果になる
// - permission: App 未インストールや権限不足で、設定が直るまで retry しても同じ結果になる
// - undeterminable: source や PR の対応を一意に決められず、誤更新を避けて止める
export type DispatchErrorKind = "retryable" | "config" | "permission" | "undeterminable";

export class DispatchError extends Error {
  readonly retryAfterSeconds: number | undefined;

  constructor(
    readonly kind: DispatchErrorKind,
    message: string,
    options?: ErrorOptions & { retryAfterSeconds?: number }
  ) {
    super(message, options);
    this.name = "DispatchError";
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

// 再実行しても結果が変わらない失敗
// それ以外（retryable と想定外の例外）は再実行で直る可能性がある
export const isPermanent = (error: unknown): error is DispatchError =>
  error instanceof DispatchError && error.kind !== "retryable";
