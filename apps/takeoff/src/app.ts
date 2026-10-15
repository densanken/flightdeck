import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { EnvValidationError, validateEnv } from "./env.js";
import { requestLogger } from "./middleware/logger.js";
import { errorDetail } from "./util/error-detail.js";
import { logger } from "./util/logger.js";

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
        logger.log("error", { event: "env_validation_failed", error: error.message });
        return c.json({ type: "invalid_environment", message: error.message }, 500);
      }
      throw error;
    }
    await next();
  });
  app.use(requestLogger());
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
  // route が捕捉しなかった例外も共通 logger を通して記録する
  // body limit の 413 など、hono が status を決めて投げる例外はその response を返す
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    logger.log("error", { event: "unhandled_error", error: errorDetail(error) });
    return c.json({ ok: false, code: "INTERNAL_ERROR" }, 500);
  });

  return app;
};
