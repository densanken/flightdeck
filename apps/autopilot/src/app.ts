import { Hono } from "hono";

import type { Env } from "./env.js";

interface AppEnvironment {
  Bindings: Env;
}

export interface AppDependencies {
  createWebhookHandler(env: Env, context: Pick<ExecutionContext, "waitUntil">): (request: Request) => Promise<Response>;
}

export const createApp = (dependencies: AppDependencies) => {
  const app = new Hono<AppEnvironment>();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.post("/webhooks/github", (c) => dependencies.createWebhookHandler(c.env, c.executionCtx)(c.req.raw));
  app.all("/webhooks/github", (c) => {
    c.header("Allow", "POST");
    return c.json({ ok: false, code: "INVALID_REQUEST" }, 405);
  });

  app.notFound((c) => c.json({ ok: false, code: "NOT_FOUND" }, 404));

  return app;
};
