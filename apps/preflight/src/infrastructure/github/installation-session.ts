import { createGitHubAppJwt } from "./app-auth.js";
import { getAuthenticatedAppBotUserId } from "./app-identity.js";
import { createInstallationAccessToken } from "./installation-token.js";
import { AppError, GitHubError, RequestTimeoutError } from "../../errors.js";
import { isAbortError, raceWithSignal } from "../../util/timeout.js";

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface AppBotIdentityCache {
  get(appId: string): number | undefined;
  set(appId: string, botUserId: number): void;
}

export interface GitHubInstallationSessionOptions {
  installationId: number;
  getCredentials: () => GitHubAppCredentials;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  appBotIdentityCache?: AppBotIdentityCache;
  createAppJwt?: typeof createGitHubAppJwt;
  createInstallationToken?: typeof createInstallationAccessToken;
  resolveAppBotUserId?: typeof getAuthenticatedAppBotUserId;
  createSharedOperationSignal?: () => AbortSignal;
}

const SHARED_OPERATION_TIMEOUT_MS = 60_000;

const normalizeAuthenticationError = (error: unknown, signal: AbortSignal): never => {
  if (signal.aborted || isAbortError(error)) {
    throw new RequestTimeoutError(
      "GitHub App authentication operation timed out",
      signal.aborted ? (signal.reason as unknown) : error
    );
  }
  if (error instanceof AppError) throw error;
  throw new GitHubError(
    "GITHUB_AUTH_FAILED",
    "GitHub App authentication operation failed",
    undefined,
    undefined,
    undefined,
    {
      cause: error,
    }
  );
};

export class GitHubInstallationSession {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly appBotIdentityCache: AppBotIdentityCache;
  private readonly createAppJwt: typeof createGitHubAppJwt;
  private readonly createInstallationToken: typeof createInstallationAccessToken;
  private readonly resolveAppBotUserId: typeof getAuthenticatedAppBotUserId;
  private readonly createSharedOperationSignal: () => AbortSignal;
  private appJwtPromise: Promise<string> | undefined;
  private authenticatedAppBotUserIdPromise: Promise<number> | undefined;
  private installationTokenPromise: Promise<string> | undefined;

  constructor(private readonly options: GitHubInstallationSessionOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.appBotIdentityCache = options.appBotIdentityCache ?? new Map<string, number>();
    this.createAppJwt = options.createAppJwt ?? createGitHubAppJwt;
    this.createInstallationToken = options.createInstallationToken ?? createInstallationAccessToken;
    this.resolveAppBotUserId = options.resolveAppBotUserId ?? getAuthenticatedAppBotUserId;
    this.createSharedOperationSignal =
      options.createSharedOperationSignal ?? (() => AbortSignal.timeout(SHARED_OPERATION_TIMEOUT_MS));
  }

  async getInstallationToken(signal: AbortSignal): Promise<string> {
    try {
      const promise = (this.installationTokenPromise ??= this.startInstallationTokenCreation());
      return await raceWithSignal(promise, signal);
    } catch (error) {
      return normalizeAuthenticationError(error, signal);
    }
  }

  async getAuthenticatedAppBotUserId(signal: AbortSignal): Promise<number> {
    try {
      const cachedBotUserId = this.appBotIdentityCache.get(this.options.getCredentials().appId);
      if (cachedBotUserId !== undefined) return await raceWithSignal(Promise.resolve(cachedBotUserId), signal);

      const promise = (this.authenticatedAppBotUserIdPromise ??= this.startAppBotUserIdResolution());
      return await raceWithSignal(promise, signal);
    } catch (error) {
      return normalizeAuthenticationError(error, signal);
    }
  }

  private startInstallationTokenCreation(): Promise<string> {
    const operationSignal = this.createSharedOperationSignal();
    const promise = this.loadInstallationToken(operationSignal).catch((error: unknown) =>
      normalizeAuthenticationError(error, operationSignal)
    );
    void promise.then(undefined, () => {
      // underlying request の失敗時だけ破棄し caller 側 signal の abort では有効な token を維持する
      if (this.installationTokenPromise === promise) this.installationTokenPromise = undefined;
    });
    return promise;
  }

  private startAppBotUserIdResolution(): Promise<number> {
    const operationSignal = this.createSharedOperationSignal();
    const promise = this.loadAuthenticatedAppBotUserId(operationSignal).catch((error: unknown) =>
      normalizeAuthenticationError(error, operationSignal)
    );
    void promise.then(undefined, () => {
      if (this.authenticatedAppBotUserIdPromise === promise) this.authenticatedAppBotUserIdPromise = undefined;
    });
    return promise;
  }

  private getAppJwt(signal: AbortSignal): Promise<string> {
    const promise = (this.appJwtPromise ??= this.startAppJwtCreation());
    return raceWithSignal(promise, signal);
  }

  private startAppJwtCreation(): Promise<string> {
    const promise = this.createAppJwt({ ...this.options.getCredentials(), now: this.now() });
    void promise.then(undefined, () => {
      if (this.appJwtPromise === promise) this.appJwtPromise = undefined;
    });
    return promise;
  }

  private async loadInstallationToken(signal: AbortSignal): Promise<string> {
    return this.createInstallationToken({
      installationId: this.options.installationId,
      appJwt: await this.getAppJwt(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
  }

  private async loadAuthenticatedAppBotUserId(signal: AbortSignal): Promise<number> {
    const credentials = this.options.getCredentials();
    const botUserId = await this.resolveAppBotUserId({
      appJwt: await this.getAppJwt(signal),
      installationToken: await this.getInstallationToken(signal),
      fetchImpl: this.fetchImpl,
      signal,
    });
    this.appBotIdentityCache.set(credentials.appId, botUserId);
    return botUserId;
  }
}
