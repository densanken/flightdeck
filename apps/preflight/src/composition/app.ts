import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";

import { budgetedCacheStorage, createSubrequestBudget } from "./subrequest-budget.js";
import { createApp } from "../app.js";
import { TITLE_STATUS_MESSAGES } from "../domain/title-status-message.js";
import { getGitHubAuthConfig, getRuntimeOptions, getWebhookSecret, parseGitHubAppBotUserId } from "../env.js";
import { ConfigurationError } from "../errors.js";
import { createQueuedGitHubWebhookHandler } from "../handler/github/webhook-queue.js";
import { createGitHubWebhookProcessor, HARD_DEADLINE_MS } from "../handler/github/webhook.js";
import { setPullRequestTitleStatus } from "../infrastructure/github/commit-status.js";
import { GitHubInstallationSession } from "../infrastructure/github/installation-session.js";
import { GitHubPullRequestGatewayImpl } from "../infrastructure/github/pull-request-gateway.js";
import { CacheDeliveryRepository } from "../repository/delivery/impl.js";
import { AssignPullRequestAuthorUseCaseImpl } from "../usecase/assignment/impl.js";
import { PullRequestPolicyUseCaseImpl } from "../usecase/pull-request-policy/impl.js";
import { ValidatePullRequestTitleUseCaseImpl } from "../usecase/title-validation/impl.js";
import { jsonResponse } from "../util/http-response.js";
import { createLogger } from "../util/logger.js";

import type { SubrequestPurpose } from "./subrequest-budget.js";
import type { Env, RuntimeOptions } from "../env.js";
import type { PullRequestWebhookPayload } from "../handler/github/payload.js";
import type { GitHubWebhookProcessOutcome, WebhookDelivery } from "../handler/github/webhook.js";
import type { AppBotIdentityCache } from "../infrastructure/github/installation-session.js";
import type { CacheStorageLike } from "../repository/delivery/impl.js";
import type { Logger } from "../util/logger.js";

// 安定した Bot user ID だけを isolate 内で共有し、token や JWT は保持しない
const appBotIdentityCache = new Map<string, number>();

export interface PlatformDependencies {
  appBotIdentityCache?: AppBotIdentityCache;
  cacheStorage?: CacheStorageLike;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  cacheOperationTimeoutMs?: number;
  createHardDeadlineSignal?: () => AbortSignal;
  createSoftDeadlineSignal?: () => AbortSignal;
  verifySignature?: typeof verifyGitHubWebhookSignature;
}

export const composeGitHubWebhookProcessor =
  (env: Env, platform: PlatformDependencies = {}, runtimeOptions?: RuntimeOptions) =>
  async (payload: PullRequestWebhookPayload, delivery: WebhookDelivery): Promise<GitHubWebhookProcessOutcome> => {
    const startedAt = Date.now();
    try {
      const hardDeadlineSignal = platform.createHardDeadlineSignal?.() ?? AbortSignal.timeout(HARD_DEADLINE_MS);
      const resolvedRuntimeOptions = runtimeOptions ?? getRuntimeOptions(env);
      const logger = platform.logger ?? createLogger(resolvedRuntimeOptions.logLevel);
      const now = platform.now ?? (() => new Date());
      const fetchImpl = platform.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
      const budget = createSubrequestBudget(logger, delivery.deliveryId);
      const budgetedFetch =
        (purpose: SubrequestPurpose): typeof fetch =>
        (input, init) => {
          budget.consume(purpose);
          return fetchImpl(input, init);
        };
      const normalFetch = budgetedFetch("normal");
      const deliveryRepository = new CacheDeliveryRepository(
        resolvedRuntimeOptions.deliveryCacheTtlSeconds,
        budgetedCacheStorage(platform.cacheStorage ?? caches, budget),
        platform.cacheOperationTimeoutMs
      );
      // pending status と検証本体で installation access token を共有する
      const sessions = new Map<number, GitHubInstallationSession>();
      const getSession = (installationId: number): GitHubInstallationSession => {
        const existing = sessions.get(installationId);
        if (existing) return existing;
        const session = new GitHubInstallationSession({
          installationId,
          getCredentials: () => getGitHubAuthConfig(env),
          fetchImpl: normalFetch,
          now,
          appBotIdentityCache: platform.appBotIdentityCache ?? appBotIdentityCache,
          createSharedOperationSignal: () => hardDeadlineSignal,
        });
        sessions.set(installationId, session);
        return session;
      };
      const policyUseCase = new PullRequestPolicyUseCaseImpl({
        deliveryRepository,
        createGateway: (installationId) =>
          new GitHubPullRequestGatewayImpl(getSession(installationId), logger, delivery.deliveryId, normalFetch),
        createAssignmentUseCase: (gateway) =>
          new AssignPullRequestAuthorUseCaseImpl({ githubGateway: gateway, skipBots: resolvedRuntimeOptions.skipBots }),
        createTitleValidationUseCase: (installationId) => {
          const session = getSession(installationId);
          const makeGateway = (purpose: SubrequestPurpose) =>
            new GitHubPullRequestGatewayImpl(session, logger, delivery.deliveryId, budgetedFetch(purpose));
          return new ValidatePullRequestTitleUseCaseImpl(
            makeGateway("normal"),
            () => parseGitHubAppBotUserId(env.GITHUB_APP_BOT_USER_ID),
            {
              sweep: makeGateway("sweep"),
              recovery: makeGateway("recovery"),
              recoveryStatus: makeGateway("recovery_status"),
              budget,
              log: (result, count, sha) => {
                logger.log("warn", {
                  event: "github_webhook_consume",
                  feature: "title-validation",
                  result,
                  deliveryId: delivery.deliveryId,
                  commitCount: count,
                  headSha: sha,
                });
              },
            }
          );
        },
        now,
      });
      return await createGitHubWebhookProcessor({
        policyUseCase,
        logger,
        hardDeadlineSignal,
        createSoftDeadlineSignal: platform.createSoftDeadlineSignal,
        hasProcessedTitleValidation: (id, signal) => deliveryRepository.has(id, "title-validation", signal),
        setPendingTitleStatus: async (input, signal) => {
          await setPullRequestTitleStatus({
            owner: input.owner,
            repo: input.repo,
            sha: input.sha,
            state: "pending",
            ...TITLE_STATUS_MESSAGES.pending,
            installationToken: await getSession(input.installationId).getInstallationToken(signal),
            fetchImpl: normalFetch,
            signal,
          });
        },
      })(payload, delivery);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      (platform.logger ?? createLogger("info")).log("error", {
        event: "github_webhook_consume",
        result: "internal_error",
        deliveryId: delivery.deliveryId,
        durationMs: Date.now() - startedAt,
        errorCode: error.code,
        configKey: error.configKey,
        configReason: error.reason,
      });
      return { status: "failed", errorCode: error.code };
    }
  };

const composeQueuedGitHubWebhookHandler =
  (env: Env, platform: PlatformDependencies) =>
  async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    try {
      const runtimeOptions = getRuntimeOptions(env);
      return await createQueuedGitHubWebhookHandler({
        enqueueWebhookDelivery: async (message) => {
          if (!env.GITHUB_WEBHOOK_QUEUE) throw new Error("GITHUB_WEBHOOK_QUEUE binding is missing");
          await env.GITHUB_WEBHOOK_QUEUE.send(message);
        },
        getWebhookSecret: () => getWebhookSecret(env),
        logger: platform.logger ?? createLogger(runtimeOptions.logLevel),
        verifySignature: platform.verifySignature ?? verifyGitHubWebhookSignature,
        createDeadlineSignal: platform.createHardDeadlineSignal,
      })(request);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      (platform.logger ?? createLogger("info")).log("error", {
        event: "github_webhook_receive",
        result: "internal_error",
        durationMs: Date.now() - startedAt,
        errorCode: error.code,
        configKey: error.configKey,
        configReason: error.reason,
      });
      return jsonResponse({ ok: false, code: error.code }, error.statusCode);
    }
  };

export const composeApp = (platform: PlatformDependencies = {}) =>
  createApp({ createGitHubWebhookHandler: (env) => composeQueuedGitHubWebhookHandler(env, platform) });
