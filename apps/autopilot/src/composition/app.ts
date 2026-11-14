import { GitHubRequest, MAX_SUBREQUESTS } from "@flightdeck/github-policy";
import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";
import { createLogger } from "@flightdeck/logger";

import { createApp } from "../app.js";
import { getMergeSettings, getWebhookSecret } from "../env.js";
import { createWebhookHandler } from "../handler/github/webhook.js";
import { GitHubGatewayImpl } from "../infrastructure/github/client.js";
import { EXECUTION_TIMEOUT_MS } from "../usecase/merge/dependencies.js";
import { MergeUseCaseImpl } from "../usecase/merge/impl.js";

export const composeApp = () =>
  createApp({
    createWebhookHandler: (env, context) =>
      createWebhookHandler({
        logger: createLogger(),
        getWebhookSecret: () => getWebhookSecret(env),
        verifySignature: verifyGitHubWebhookSignature,
        waitUntil: (promise) => {
          context.waitUntil(promise);
        },
        createUseCase: (input) => {
          const settings = getMergeSettings(env);
          const github = new GitHubGatewayImpl(
            new GitHubRequest(
              settings.appId,
              settings.privateKey,
              input.installationId,
              "flightdeck-autopilot",
              Date.now() + EXECUTION_TIMEOUT_MS
            ),
            input.repository
          );
          return new MergeUseCaseImpl({
            settings,
            github,
            logger: createLogger(),
            clock: Date.now,
            maxSubrequests: MAX_SUBREQUESTS,
          });
        },
      }),
  });
