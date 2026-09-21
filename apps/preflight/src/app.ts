import { Hono } from "hono";

import type { Env } from "./env.js";
import type { ErrorCode } from "./errors.js";

interface AppEnvironment {
  Bindings: Env;
}

export interface AppDependencies {
  createGitHubWebhookHandler(env: Env): (request: Request) => Promise<Response>;
}

export const createApp = (dependencies: AppDependencies) => {
  const app = new Hono<AppEnvironment>();

  // routing が返す 404 と 405 を含め、すべての応答で cache と MIME sniffing を抑止する
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.post("/webhooks/github", (c) => dependencies.createGitHubWebhookHandler(c.env)(c.req.raw));
  app.all("/webhooks/github", (c) => {
    c.header("Allow", "POST");
    return c.json({ ok: false, code: "INVALID_REQUEST" satisfies ErrorCode }, 405);
  });

  app.notFound((c) => c.json({ ok: false, code: "NOT_FOUND" satisfies ErrorCode }, 404));

  return app;
};
