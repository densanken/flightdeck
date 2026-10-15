import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import { composeApp } from "./composition/app.js";
import { logger } from "./util/logger.js";

import type { Env } from "./env.js";

const bindings = (): Env["Bindings"] => ({
  ...env,
  GITHUB_APP_PRIVATE_KEY: "private-key",
  DISCORD_PUBLIC_KEY: "public-key",
  DISCORD_APPLICATION_ID: "application-id",
  MERGE_AUDIT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token",
  GITHUB_APP_ID: "github-app-id",
  GITHUB_ORG: "org",
  ALLOWED_GUILD_IDS: "guild-id",
  ADMIN_ROLE_IDS: "role-id",
  PUBLIC_BASE_URL: "https://takeoff.example.com",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("application routing", () => {
  it("health endpoint を返す", async () => {
    const response = await composeApp().request("/health", undefined, bindings());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("未定義の path に ok: false の 404 を返す", async () => {
    const response = await composeApp().request("/", undefined, bindings());

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("必須 env がない場合に記録して 500 を返す", async () => {
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    const response = await composeApp().request("/health", undefined, {
      ...bindings(),
      GITHUB_ORG: "",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ type: "invalid_environment" });
    expect(logSpy).toHaveBeenCalledWith("error", expect.objectContaining({ event: "env_validation_failed" }));
  });

  it("route が捕捉しなかった例外を記録して 500 を返す", async () => {
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    const discord = new Hono<Env>().get("/boom", () => {
      throw new TypeError("broken");
    });
    const app = createApp({ discord, github: new Hono<Env>() });

    const response = await app.request("/discord/boom", undefined, bindings());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(logSpy).toHaveBeenCalledWith("error", { event: "unhandled_error", error: "TypeError: broken" });
  });

  it("body limit を超えた request には hono が決めた 413 を返し、未処理の例外として記録しない", async () => {
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });

    const response = await composeApp().request(
      "/webhooks/github",
      { method: "POST", body: "x".repeat(1024 * 1024) },
      bindings()
    );

    expect(response.status).toBe(413);
    expect(logSpy).not.toHaveBeenCalledWith("error", expect.objectContaining({ event: "unhandled_error" }));
  });
});
