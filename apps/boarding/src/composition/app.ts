import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";

import { createApp } from "../app.js";
import { getBotUserId, getGitHubAppCredentials, getGitHubAppId, getWebhookSecret } from "../env.js";
import { createMessageConsumer } from "../handler/github/consume.js";
import { createWebhookHandler } from "../handler/github/webhook.js";
import { readEditors, readWebsite } from "../infrastructure/config/parse.js";
import { GitHubApprove } from "../infrastructure/github/approve.js";
import { GitHubInstallationTokenProvider } from "../infrastructure/github/auth.js";
import { GitHubCheckRun } from "../infrastructure/github/check-run.js";
import { GitHubComment } from "../infrastructure/github/comment.js";
import { GitHubGatewayImpl } from "../infrastructure/github/evaluation.js";
import { GitHubMemberships } from "../infrastructure/github/memberships.js";
import { GitHubOpenPullRequests } from "../infrastructure/github/pull-requests.js";
import { GitHubRequest } from "../infrastructure/github/request.js";
import { createBatchEnqueue } from "../infrastructure/queue/enqueue.js";
import { authorizationComment } from "../message/authorization.js";
import { EvaluateUseCaseImpl } from "../usecase/evaluate/impl.js";
import { FanoutUseCaseImpl } from "../usecase/fanout/impl.js";
import { PublishUseCaseImpl } from "../usecase/publish/impl.js";
import { createLogger } from "../util/logger.js";

import type { Env } from "../env.js";

export const composeApp = () =>
  createApp({
    createWebhookHandler: (env: Env) =>
      createWebhookHandler({
        getWebhookSecret: () => getWebhookSecret(env),
        getBotUserId: () => getBotUserId(env),
        verifySignature: verifyGitHubWebhookSignature,
        enqueue: async (message) => {
          await env.GITHUB_WEBHOOK_QUEUE.send(message);
        },
        logEnqueueFailure: (deliveryId) => {
          createLogger().log("error", { event: "enqueue_failed", deliveryId });
        },
      }),
  });

export const composeMessageConsumer = (env: Env) =>
  createMessageConsumer({
    logger: createLogger(),
    createUseCases: (message) => {
      const request = new GitHubRequest((input, init) => fetch(input, init));
      // 評価後の書き込みに最大 12 回の予算を残す
      const evaluationRequest = request.withLimit(23);
      const tokens = new GitHubInstallationTokenProvider({
        request,
        ...getGitHubAppCredentials(env),
        installationId: message.installationId,
      });
      const getToken = () => tokens.getToken();
      const evaluation = new GitHubGatewayImpl({ request: evaluationRequest, getToken });
      const publication = new GitHubGatewayImpl({ request, getToken });
      const memberships = new GitHubMemberships({ request: evaluationRequest, getToken });
      const open = new GitHubOpenPullRequests({ request, getToken });
      const evaluate = new EvaluateUseCaseImpl({
        gateway: {
          files: evaluation.files.bind(evaluation),
          validateEditors: memberships.validateEditors.bind(memberships),
          teamMemberships: memberships.teamMemberships.bind(memberships),
          orgMembership: memberships.orgMembership.bind(memberships),
        },
        readEditors,
        readWebsite,
      });
      const appId = getGitHubAppId(env);
      const check = new GitHubCheckRun({
        request,
        getToken,
        appId,
        verify: (number, baseSha, headSha) => publication.verify(number, baseSha, headSha),
      });
      const comment = new GitHubComment({
        request,
        getToken,
        botUserId: getBotUserId(env),
        verify: (number, baseSha, headSha) => publication.verify(number, baseSha, headSha),
      });
      const approve = new GitHubApprove({
        request,
        getToken,
        botUserId: getBotUserId(env),
        verify: (number, baseSha, headSha) => publication.verify(number, baseSha, headSha),
      });
      return {
        publish: new PublishUseCaseImpl({
          botUserId: getBotUserId(env),
          approve: (input) => approve.write(input),
          comment: (input) => comment.write(input),
          formatComment: authorizationComment,
          evaluate,
          current: (number) => publication.current(number),
          pullRequest: (number) => evaluation.pullRequest(number),
          startCheck: (input) => check.start(input),
          finishCheck: (input) => check.finish(input),
        }),
        fanout: new FanoutUseCaseImpl({
          verifyInstallation: () => tokens.verifyInstallation(),
          listOpenPullRequests: () => open.list(),
          enqueue: createBatchEnqueue(env.GITHUB_WEBHOOK_QUEUE),
        }),
      };
    },
  });
