import { GitHubError, RequestTimeoutError } from "../../errors.js";
import { isAbortError, raceWithSignal } from "../../util/timeout.js";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";

const USER_AGENT = "preflight";
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BUDGET_MS = 2_000;
const BASE_RETRY_DELAY_MS = 100;

export type GitHubErrorCode = "GITHUB_AUTH_FAILED" | "GITHUB_API_FAILED";

interface GitHubRetryOptions {
  maxAttempts?: number;
  retryBudgetMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

const requestHeaders = (token: string, hasBody: boolean): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": USER_AGENT,
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
  ...(hasBody ? { "Content-Type": "application/json" } : {}),
});

export const githubRequest = async (input: {
  url: string;
  method: "DELETE" | "GET" | "PATCH" | "POST";
  token: string;
  body?: unknown;
  expectedStatuses: readonly number[];
  errorCode: GitHubErrorCode;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  retry?: boolean | GitHubRetryOptions;
}): Promise<Response> => {
  const retryEnabled = input.method === "GET" || input.retry === true || typeof input.retry === "object";
  const retryOptions = typeof input.retry === "object" ? input.retry : {};
  const maxAttempts = retryEnabled ? (retryOptions.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS) : 1;
  const now = retryOptions.now ?? Date.now;
  const random = retryOptions.random ?? Math.random;
  const sleep =
    retryOptions.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const retryDeadline = now() + (retryOptions.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS);
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      if (input.signal.aborted) throw input.signal.reason;
      response = await raceWithSignal(
        input.fetchImpl(input.url, {
          method: input.method,
          headers: requestHeaders(input.token, input.body !== undefined),
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: input.signal,
        }),
        input.signal
      );
      lastNetworkError = undefined;
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) {
        throw new RequestTimeoutError("GitHub API request timed out", timeoutCause(error, input.signal));
      }
      lastNetworkError = error;
      if (attempt === maxAttempts || !retryEnabled) break;
      const delayMs = retryDelayMs(undefined, attempt, now(), random);
      if (now() + delayMs > retryDeadline) break;
      await sleepBeforeRetry(sleep, delayMs, input.signal);
      continue;
    }

    if (input.expectedStatuses.includes(response.status)) return response;
    if (!isRetryableResponse(response) || attempt === maxAttempts || !retryEnabled) {
      throwResponseError(input.errorCode, response);
    }

    const delayMs = retryDelayMs(response, attempt, now(), random);
    if (now() + delayMs > retryDeadline) throwResponseError(input.errorCode, response);
    discardResponseBody(response);
    await sleepBeforeRetry(sleep, delayMs, input.signal);
  }

  if (lastNetworkError !== undefined) {
    throw new GitHubError(input.errorCode, "GitHub API request failed", undefined, undefined, undefined, {
      cause: lastNetworkError,
    });
  }
  throw new GitHubError(input.errorCode, "GitHub API retry budget exhausted");
};

const timeoutCause = (error: unknown, signal: AbortSignal): unknown =>
  signal.aborted ? (signal.reason as unknown) : error;

const sleepBeforeRetry = async (
  sleep: (delayMs: number) => Promise<void>,
  delayMs: number,
  signal: AbortSignal
): Promise<void> => {
  try {
    await raceWithSignal(sleep(delayMs), signal);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new RequestTimeoutError("GitHub API retry wait timed out", timeoutCause(error, signal));
    }
    throw error;
  }
};

const isRetryableResponse = (response: Response): boolean =>
  response.status === 429 ||
  (response.status >= 500 && response.status <= 599) ||
  (response.status === 403 &&
    (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"));

const retryAfterMs = (value: string | null, nowMs: number): number | null => {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
};

const rateLimitResetMs = (value: string | null, nowMs: number): number | null => {
  if (value === null) return null;
  const epochSeconds = Number(value);
  return Number.isFinite(epochSeconds) && epochSeconds >= 0 ? Math.max(0, epochSeconds * 1_000 - nowMs) : null;
};

const retryDelayMs = (response: Response | undefined, attempt: number, nowMs: number, random: () => number) => {
  const requestedDelay = retryAfterMs(response?.headers.get("retry-after") ?? null, nowMs);
  if (requestedDelay !== null) return requestedDelay;
  const resetDelay = rateLimitResetMs(response?.headers.get("x-ratelimit-reset") ?? null, nowMs);
  if (resetDelay !== null) return resetDelay;
  const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  return Math.ceil(exponentialDelay * (1 + Math.max(0, Math.min(1, random()))));
};

const responseError = (errorCode: GitHubErrorCode, response: Response): GitHubError =>
  new GitHubError(
    errorCode,
    `GitHub API returned ${String(response.status)}`,
    response.status,
    response.headers.get("x-github-request-id") ?? undefined,
    response.headers.get("retry-after") ?? undefined
  );

const discardResponseBody = (response: Response): void => {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // response body の破棄失敗は、元の retry 判定や GitHubError を変えない
  }
};

const throwResponseError = (errorCode: GitHubErrorCode, response: Response): never => {
  const error = responseError(errorCode, response);
  discardResponseBody(response);
  throw error;
};

export const invalidShapeError = (response: Response, code: GitHubErrorCode, resource: string): GitHubError =>
  new GitHubError(
    code,
    `GitHub ${resource} response has an invalid shape`,
    response.status,
    response.headers.get("x-github-request-id") ?? undefined
  );

// rel の parameter 位置は固定されず、引用符なしの token と空白区切りの複数関係型（rel="prev next"）も
// 取りうるため、値を空白で分割して next という token の有無で判定する
// rel="next-page" は別の 1 token なので一致しない
// URI-Reference 内の ";rel=" を parameter と取り違えないよう "<...>" の後ろだけを見る
// quoted-string の escape は解釈しないため、他の parameter の引用符内に rel= があると next を見落とす
const hasNextRel = (part: string): boolean => {
  const parameters = part.slice(part.indexOf(">") + 1);
  const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/.exec(parameters);
  const value = rel?.[1] ?? rel?.[2] ?? "";
  return value.split(/\s+/).includes("next");
};

// REST の pagination は Link header の rel="next" だけをたどる
// 別 origin や別 path への誘導は拒否し、取得済みの一部だけで成功と判定しない
// origin と path の不一致に別々の message を使うかは呼び出し元が決める
export const nextPageUrl = (
  header: string | null,
  currentUrl: string,
  expectedPath: string,
  messages: { invalidUrl: string; invalidPath: string }
): string | null => {
  if (!header) return null;
  // URL 内に生の "," があると part が壊れるが、GitHub は query を percent-encode するため起きない
  const nextPart = header.split(",").find(hasNextRel);
  if (!nextPart) return null;
  const match = /<([^>]+)>/.exec(nextPart);
  // next link がある以上まだ後続ページが残る
  // URL を取り出せないことを最終ページとして扱うと、取得済みの一部だけで成功になる
  if (!match?.[1]) throw new GitHubError("GITHUB_API_FAILED", "GitHub pagination link has no URL");
  const url = new URL(match[1], currentUrl);
  if (url.origin !== GITHUB_API_BASE_URL) throw new GitHubError("GITHUB_API_FAILED", messages.invalidUrl);
  if (url.pathname !== expectedPath) throw new GitHubError("GITHUB_API_FAILED", messages.invalidPath);
  return url.href;
};

export const readGitHubJson = async (
  response: Response,
  code: GitHubErrorCode,
  signal: AbortSignal
): Promise<unknown> => {
  try {
    return await raceWithSignal(response.json(), signal);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new RequestTimeoutError("GitHub API response body timed out", timeoutCause(error, signal));
    }
    throw new GitHubError(
      code,
      "GitHub API returned invalid JSON",
      response.status,
      response.headers.get("x-github-request-id") ?? undefined,
      undefined,
      { cause: error }
    );
  }
};
