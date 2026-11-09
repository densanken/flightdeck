import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";

import { createApp } from "../app.js";
import { getGitHubAppCredentials, getWebhookSecret } from "../env.js";
import { createMessageConsumer } from "../handler/github/consume.js";
import { createWebhookHandler } from "../handler/github/webhook.js";
import { GitHubInstallationTokenProvider } from "../infrastructure/github/auth.js";
import { GitHubGatewayImpl } from "../infrastructure/github/client.js";
import { SyncUseCaseImpl } from "../usecase/sync/impl.js";
import { createLogger } from "../util/logger.js";

import type { Env } from "../env.js";

export const composeApp = () =>
  createApp({
    createWebhookHandler: (env: Env) =>
      createWebhookHandler({
        getWebhookSecret: () => getWebhookSecret(env),
        verifySignature: verifyGitHubWebhookSignature,
        enqueue: async (message) => {
          await env.GITHUB_WEBHOOK_QUEUE.send(message);
        },
        logger: createLogger(),
      }),
  });

export const composeMessageConsumer = (env: Env) => {
  const logger = createLogger();

  return createMessageConsumer({
    logger,
    createUseCase: (message) => {
      const fetcher = (input: string, init: RequestInit) => fetch(input, init);
      const tokens = new GitHubInstallationTokenProvider({
        fetcher,
        ...getGitHubAppCredentials(env),
        installation: message.installation,
      });
      const getToken = (repository: string) => tokens.getToken(repository);

      return new SyncUseCaseImpl({
        gateway: new GitHubGatewayImpl({ fetcher, getToken }),
        // 子 message は同じ Queue へまとめて積む（1 回の sendBatch は 100 件まで、target と管理 branch の数はそれ以内）
        enqueue: async (children) => {
          if (children.length === 0) return;

          const { deliveryId, installation } = message;
          await env.GITHUB_WEBHOOK_QUEUE.sendBatch(
            children.map((child) => ({ body: { ...child, deliveryId, installation } }))
          );
        },
        logger,
      });
    },
  });
};
