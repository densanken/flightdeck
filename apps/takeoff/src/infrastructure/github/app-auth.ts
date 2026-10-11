import { createGitHubAppJwt as signGitHubAppJwt } from "@flightdeck/github-app-jwt";
import { z } from "zod";

import { createGitHubResponseError, GITHUB_API_VERSION, GitHubError, withGitHubTimeout } from "./client.js";
import { gitHubInstallationSchema, gitHubInstallationTokenSchema } from "./types.js";
import { cacheKeys } from "../cache/keys.js";
import { memoryCache } from "../cache/memory-cache.js";
import { workersCache } from "../cache/workers-api.js";

// installation token の有効期限に対する安全マージン（秒）
// この分だけ手前で失効扱いにする
const INSTALLATION_TOKEN_EXPIRY_BUFFER_SECONDS = 60;
// memory cache に token を載せる最大時間（秒）
// 実際の残り時間がこれより短ければそちらを優先する
const INSTALLATION_TOKEN_MEMORY_TTL_SECONDS = 300;

const installationTokenTtlSeconds = (expiresAtMs: number): number =>
  Math.floor((expiresAtMs - Date.now()) / 1000) - INSTALLATION_TOKEN_EXPIRY_BUFFER_SECONDS;

class StaleInstallationIdError extends GitHubError {
  constructor(installationId: number) {
    super("unexpected_github_error", `GitHub App installation not found: ${String(installationId)}`, 502);
    this.name = "StaleInstallationIdError";
  }
}

const readJson = async (response: Response, context: string): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new GitHubError("unexpected_github_error", `Invalid GitHub JSON response: ${context}`, 502);
  }
};

export const createGitHubAppJwt = async (appId: string, privateKeyPem: string): Promise<string> => {
  try {
    return await signGitHubAppJwt({ appId, privateKeyPem });
  } catch {
    throw new GitHubError("unexpected_github_error", "GitHub App JWT could not be generated", 502);
  }
};

export class GitHubAppAuthImpl {
  // Workers の native fetch を property として直接保持すると、this.fetcher() の receiver が
  // GitHubAppAuthImpl になり Illegal invocation になるため、遅延束縛した wrapper を使う
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async getInstallationId(
    jwt: string,
    appId: string,
    org: string,
    cacheBaseUrl: string,
    bypassCache = false
  ): Promise<number> {
    const cacheKey = cacheKeys.installationId(cacheBaseUrl, appId, org);
    if (!bypassCache) {
      const memResult = memoryCache.get<number>(cacheKey);
      if (memResult !== null) return memResult;

      const cacheResult = await workersCache.get(cacheKey, z.number().int().positive());
      if (cacheResult !== null) {
        memoryCache.set(cacheKey, cacheResult, 3600);
        return cacheResult;
      }
    }

    const encodedOrg = encodeURIComponent(org);
    const response = await this.fetcher(`https://api.github.com/orgs/${encodedOrg}/installation`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "takeoff",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: withGitHubTimeout(),
    });

    if (!response.ok) {
      throw await createGitHubResponseError(response, `getInstallationId ${org}`, "unexpected_github_error");
    }

    const parsed = gitHubInstallationSchema.safeParse(await readJson(response, "getInstallationId"));
    if (!parsed.success) {
      throw new GitHubError("unexpected_github_error", "Invalid GitHub installation response", 502);
    }

    memoryCache.set(cacheKey, parsed.data.id, 3600);
    await workersCache.set(cacheKey, parsed.data.id, 86400);
    return parsed.data.id;
  }

  async getInstallationToken(jwt: string, installationId: number, cacheBaseUrl: string): Promise<string> {
    const cacheKey = cacheKeys.installationToken(cacheBaseUrl, installationId);
    // token は secret なので isolate 外へ永続化しない（Cache API は同一 zone の他 Worker から読めるため使わない）
    // isolate ごとに GitHub から取り直し、isolate 内の memory cache にだけ短時間載せる
    const memResult = memoryCache.get<string>(cacheKey);
    if (memResult !== null) return memResult;

    const response = await this.fetcher(
      `https://api.github.com/app/installations/${String(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "takeoff",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        signal: withGitHubTimeout(),
      }
    );

    if (response.status === 404) {
      throw new StaleInstallationIdError(installationId);
    }
    if (!response.ok) {
      throw await createGitHubResponseError(
        response,
        `getInstallationToken ${String(installationId)}`,
        "unexpected_github_error"
      );
    }

    const parsed = gitHubInstallationTokenSchema.safeParse(await readJson(response, "getInstallationToken"));
    if (!parsed.success) {
      throw new GitHubError("unexpected_github_error", "Invalid GitHub installation token response", 502);
    }

    const expiresAtMs = Date.parse(parsed.data.expires_at);
    const ttlSeconds = installationTokenTtlSeconds(expiresAtMs);
    if (ttlSeconds > 0) {
      memoryCache.set(cacheKey, parsed.data.token, Math.min(ttlSeconds, INSTALLATION_TOKEN_MEMORY_TTL_SECONDS));
    }
    return parsed.data.token;
  }

  async getAuthenticatedToken(appId: string, privateKey: string, org: string, cacheBaseUrl: string): Promise<string> {
    const jwt = await createGitHubAppJwt(appId, privateKey);
    const installationId = await this.getInstallationId(jwt, appId, org, cacheBaseUrl);
    try {
      return await this.getInstallationToken(jwt, installationId, cacheBaseUrl);
    } catch (error) {
      if (!(error instanceof StaleInstallationIdError)) throw error;
    }

    const installationIdCacheKey = cacheKeys.installationId(cacheBaseUrl, appId, org);
    memoryCache.delete(installationIdCacheKey);
    await workersCache.delete(installationIdCacheKey);

    // Cache API delete は best-effort なので、削除失敗時にも古い ID を読み直さないよう cache を bypass する
    const refreshedInstallationId = await this.getInstallationId(jwt, appId, org, cacheBaseUrl, true);
    return this.getInstallationToken(jwt, refreshedInstallationId, cacheBaseUrl);
  }
}

export const githubAppAuth = new GitHubAppAuthImpl();
