import { DispatchError } from "../../errors.js";

import type { z } from "zod";

const API_ORIGIN = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 3_600;

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface GitHubCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  // true なら 404 を undefined として返す
  optional?: boolean;
  // true なら 422 を undefined として返す
  rejectable?: boolean;
  // 応答の本文がこの byte 数を超えたら、JSON として解釈せずに undefined を返す
  // 大きな JSON の解釈は CPU 時間を使うため、Workers の CPU 時間の上限に収める
  maxBytes?: number;
}

// secondary rate limit は 403 と Retry-After で、primary rate limit は 403 か 429 と x-ratelimit-* で返る
export const retryDelaySeconds = (response: Response): number | undefined => {
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const seconds =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)
        ? Math.ceil(reset - Date.now() / 1000)
        : undefined;

  return seconds === undefined ? undefined : Math.min(Math.max(seconds, 1), MAX_RETRY_DELAY_SECONDS);
};

const toError = async (response: Response, call: GitHubCall): Promise<DispatchError> => {
  const where = `${call.method} ${call.path} -> ${String(response.status)}`;
  const rateLimitDelay = retryDelaySeconds(response);

  if (response.status === 429 || (response.status === 403 && rateLimitDelay !== undefined)) {
    return new DispatchError("retryable", `GitHub rate limited: ${where}`, {
      retryAfterSeconds: rateLimitDelay ?? DEFAULT_RATE_LIMIT_DELAY_SECONDS,
    });
  }

  // secondary rate limit は Retry-After なしの 403 でも返る
  // 本文は判別にだけ使い、ログには出さない
  if (response.status === 403 && /secondary rate limit/i.test(await response.text().catch(() => ""))) {
    return new DispatchError("retryable", `GitHub rate limited: ${where}`, {
      retryAfterSeconds: DEFAULT_RATE_LIMIT_DELAY_SECONDS,
    });
  }

  if (response.status >= 500) return new DispatchError("retryable", `GitHub server error: ${where}`);
  if (response.status === 401 || response.status === 403)
    return new DispatchError("permission", `GitHub denied: ${where}`);

  // 一部の repository だけに入れた Installation では、入っていない repository は 404 になる
  if (response.status === 404) {
    return new DispatchError(
      "permission",
      `GitHub returned 404; the App may not have access to the repository: ${where}`
    );
  }

  // REST の書き込みが 422 で拒否されることがある（PR の作成が作成済みの PR と競合したときなど）
  // 再実行で状態を読み直せば解消するため、再試行可能とし、回数は Queue の max_retries が抑える
  if (response.status === 422) {
    return new DispatchError("retryable", `GitHub rejected the request: ${where}`);
  }

  if (response.status === 409) return new DispatchError("retryable", `GitHub conflict: ${where}`);

  return new DispatchError("undeterminable", `GitHub rejected: ${where}`);
};

export const callGitHub = async (
  fetcher: Fetcher,
  token: string,
  call: GitHubCall,
  // 応答の header（rate limit の待ち時間など）を呼び出し側が読むための hook
  onResponse?: (response: Response) => void
): Promise<unknown> => {
  let response: Response;

  try {
    response = await fetcher(`${API_ORIGIN}${call.path}`, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "flightdeck-dispatch",
        ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new DispatchError("retryable", `GitHub request failed: ${call.method} ${call.path}`, { cause });
  }

  onResponse?.(response);

  if ((response.status === 404 && call.optional) || (response.status === 422 && call.rejectable)) return undefined;
  if (!response.ok) throw await toError(response, call);

  // byte 数は文字列に decode する前に数える（decode にも CPU 時間を使うため）
  const bytes = await response.arrayBuffer();
  if (call.maxBytes !== undefined && bytes.byteLength > call.maxBytes) return undefined;

  // 本文の一部がログに出ないよう、JSON として読めない応答は内容を含めずに失敗させる
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new DispatchError("retryable", "invalid JSON response");
  }
};

export const parseResponse = <T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new DispatchError("undeterminable", `unexpected GitHub response: ${what}`);

  return parsed.data;
};
