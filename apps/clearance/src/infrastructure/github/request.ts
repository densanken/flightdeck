import { createGitHubAppJwt } from "@flightdeck/github-app-jwt";

import { normalizeError } from "./error.js";
import { ApiError, BudgetExceeded, GitHubDataError } from "../../errors.js";

export const MAX_SUBREQUESTS = 45;

const tokens = new Map<string, { token: string; expires: number }>();

export class GitHubRequest {
  count = 0;
  private token: string | undefined;
  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
    private readonly installation: number
  ) {}

  private async fetch(path: string, token: string, method: string, body?: unknown): Promise<Response> {
    if (this.count >= MAX_SUBREQUESTS) throw new BudgetExceeded();

    this.count += 1;

    return fetch(`https://api.github.com${path}`, {
      method,
      // 認証 token を別の URL に転送しない
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "flightdeck-clearance",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async authenticate(): Promise<void> {
    try {
      await this.authenticateRequest();
    } catch (error) {
      throw normalizeError(error);
    }
  }

  private async authenticateRequest(): Promise<void> {
    const key = `${this.appId}:${String(this.installation)}`;
    const cached = tokens.get(key);
    // 処理中に token が期限切れにならないよう余裕を設ける
    if (cached && cached.expires > Date.now() + 60_000) {
      this.token = cached.token;
      return;
    }

    const jwt = await createGitHubAppJwt({ appId: this.appId, privateKeyPem: this.privateKey });
    const response = await this.fetch(`/app/installations/${String(this.installation)}/access_tokens`, jwt, "POST");
    if (!response.ok) throw new ApiError(response.status);

    const data = await response.json<{ token?: unknown; expires_at?: unknown }>();
    if (typeof data.token !== "string" || typeof data.expires_at !== "string") throw new ApiError(response.status);

    const expires = Date.parse(data.expires_at);
    if (!Number.isFinite(expires)) throw new ApiError(response.status);

    this.token = data.token;
    tokens.set(key, { token: data.token, expires });
  }

  async request(
    path: string,
    method = "GET",
    body?: unknown,
    maxBytes = 1024 * 1024
  ): Promise<{ data: unknown; response: Response }> {
    try {
      return await this.sendRequest(path, method, body, maxBytes);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  private async sendRequest(
    path: string,
    method: string,
    body: unknown,
    maxBytes: number
  ): Promise<{ data: unknown; response: Response }> {
    if (!this.token) throw new Error("not authenticated");

    const response = await this.fetch(path, this.token, method, body);
    if (!response.ok) {
      const detail = response.status === 403 ? (await response.text()).toLowerCase() : "";
      throw new ApiError(
        response.status,
        detail,
        response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after") ||
          detail.includes("rate limit")
      );
    }

    // CPU 時間を守るため、上限を超える応答は JSON として解析する前に読むのをやめる
    const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (!reader) throw new Error("empty response");

    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;

      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }

      parts.push(chunk.value);
    }

    return { data: JSON.parse(await new Blob(parts).text()) as unknown, response };
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.request("/graphql", "POST", { query, variables });

    // errors を含む応答は部分的なデータでも使わない
    if (!data || typeof data !== "object" || "errors" in data || !("data" in data)) {
      throw new GitHubDataError("graphql_error", "GraphQL error");
    }

    return data.data;
  }
}
