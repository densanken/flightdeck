import { createApp } from "../app.js";
import { composeDiscordDependencies } from "./discord.js";
import { composeGitHubWebhookDependencies } from "./github.js";
import { createDiscordRoute } from "../handler/discord/route.js";
import { createGitHubWebhookRoute } from "../handler/github/webhook.js";
import { verifyDiscordSignature } from "../infrastructure/discord/signature.js";
import { verifyGitHubWebhookSignature } from "../infrastructure/github/webhook-signature.js";

export const composeApp = () => {
  const discord = createDiscordRoute({
    createDependencies: composeDiscordDependencies,
    verifySignature: verifyDiscordSignature,
  });
  const github = createGitHubWebhookRoute({
    createDependencies: composeGitHubWebhookDependencies,
    verifySignature: verifyGitHubWebhookSignature,
  });

  return createApp({ discord, github });
};
