import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";

import { createApp } from "../app.js";
import { getWebhookSecret } from "../env.js";
import { composeDiscordDependencies } from "./discord.js";
import { composeGitHubWebhookDependencies } from "./github.js";
import { createDiscordRoute } from "../handler/discord/route.js";
import { createGitHubWebhookRoute } from "../handler/github/webhook.js";
import { verifyDiscordSignature } from "../infrastructure/discord/signature.js";

export const composeApp = () => {
  const discord = createDiscordRoute({
    createDependencies: composeDiscordDependencies,
    verifySignature: verifyDiscordSignature,
  });
  const github = createGitHubWebhookRoute({
    getWebhookSecret,
    createDependencies: composeGitHubWebhookDependencies,
    verifySignature: (secret, signatureHeader, rawBody) =>
      verifyGitHubWebhookSignature({ rawBody, signatureHeader, secret }),
  });

  return createApp({ discord, github });
};
