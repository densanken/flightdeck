import { GitHubRequest, MAX_SUBREQUESTS, createSkipCache } from "@flightdeck/github-policy";
import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";
import { createLogger } from "@flightdeck/logger";

import { createApp } from "../app.js";
import { getApprovalSettings, getBotUserId, getWebhookSecret } from "../env.js";
import { createWebhookHandler } from "../handler/github/webhook.js";
import { GitHubGatewayImpl } from "../infrastructure/github/client.js";
import { ApprovalUseCaseImpl } from "../usecase/approval/impl.js";

export const composeApp = () =>
  createApp({
    createWebhookHandler: (env, context) => {
      const logger = createLogger();
      const skipCache = createSkipCache(caches.default);

      return createWebhookHandler({
        getWebhookSecret: () => getWebhookSecret(env),
        getBotUserId: () => getBotUserId(env),
        verifySignature: verifyGitHubWebhookSignature,
        waitUntil: (promise) => {
          context.waitUntil(promise);
        },
        logger,
        skipCache,
        createUseCase: (input) => {
          const settings = getApprovalSettings(env);
          const github = new GitHubGatewayImpl(
            new GitHubRequest(settings.appId, settings.privateKey, input.installationId, "flightdeck-clearance"),
            input.repository
          );

          return new ApprovalUseCaseImpl({
            settings,
            github,
            logger,
            skipCache,
            clock: Date.now,
            random: Math.random,
            maxSubrequests: MAX_SUBREQUESTS,
          });
        },
      });
    },
  });
