import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { composeApp } from "./composition/app.js";

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

  it("必須 env がない場合に 500 を返す", async () => {
    const response = await composeApp().request("/health", undefined, {
      ...bindings(),
      GITHUB_ORG: "",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ type: "invalid_environment" });
  });
});
