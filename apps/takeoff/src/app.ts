import { Hono } from "hono";

import { EnvValidationError, validateEnv } from "./env.js";
import { redactingLogger } from "./middleware/logger.js";

import type { Env } from "./env.js";

export interface AppDependencies {
  discord: Hono<Env>;
  github: Hono<Env>;
}

export const createApp = ({ discord, github }: AppDependencies) => {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    try {
      validateEnv(c.env);
    } catch (error) {
      if (error instanceof EnvValidationError) {
        return c.json({ type: "invalid_environment", message: error.message }, 500);
      }
      throw error;
    }
    await next();
  });
  app.use(redactingLogger());
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  app.route("/discord", discord);
  app.route("/webhooks", github);

  app.notFound((c) => c.json({ ok: false, code: "NOT_FOUND" }, 404));

  return app;
};
