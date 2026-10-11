import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { EnvValidationError, validateEnv } from "./env.js";

import type { Env } from "./env.js";

const validBindings = (): Env["Bindings"] => ({
  GITHUB_APP_PRIVATE_KEY: "private-key",
  DISCORD_PUBLIC_KEY: "public-key",
  DISCORD_APPLICATION_ID: "application-id",
  DISCORD_BOT_TOKEN: "bot-token",
  MERGE_AUDIT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token",
  GITHUB_APP_ID: "github-app-id",
  GITHUB_ORG: "org",
  ALLOWED_GUILD_IDS: "guild-id",
  ADMIN_ROLE_IDS: "role-id",
  PUBLIC_BASE_URL: "https://takeoff.example.com",
  KV: env.KV,
});

describe("validateEnv", () => {
  it("有効な必須 env を受け入れる", () => {
    expect(() => {
      validateEnv(validBindings());
    }).not.toThrow();
  });

  it("必須 env の空文字を拒否する", () => {
    expect(() => {
      validateEnv({ ...validBindings(), GITHUB_ORG: "" });
    }).toThrow(EnvValidationError);
  });

  it("必須 env が undefined なら拒否する", () => {
    const b = validBindings();
    // runtime で undefined になるケースを TypeScript の型を迂回して強制する
    (b as Record<string, unknown>).GITHUB_ORG = undefined;
    expect(() => {
      validateEnv(b);
    }).toThrow(EnvValidationError);
  });

  it.each(["http://localhost:8787", "https://takeoff.example.com"])(
    "http(s) の PUBLIC_BASE_URL %s を受け入れる",
    (url) => {
      expect(() => {
        validateEnv({ ...validBindings(), PUBLIC_BASE_URL: url });
      }).not.toThrow();
    }
  );

  it.each(["not a url", "localhost:8787", "ftp://example.com"])(
    "http(s) URL でない PUBLIC_BASE_URL %s を拒否する",
    (url) => {
      expect(() => {
        validateEnv({ ...validBindings(), PUBLIC_BASE_URL: url });
      }).toThrow("PUBLIC_BASE_URL must be a valid http(s) URL");
    }
  );

  it.each([
    "http://discord.com/api/webhooks/1/token",
    "https://example.com/api/webhooks/1/token",
    "https://discord.com.attacker.example/api/webhooks/1/token",
    "https://discord.com/api/not-webhooks/1/token",
    "https://discord.com/api/webhooks/not-numeric/token",
    "https://discord.com/api/webhooks/1/token?wait=true",
  ])("不正な MERGE_AUDIT_DISCORD_WEBHOOK_URL %s を拒否する", (webhookUrl) => {
    expect(() => {
      validateEnv({ ...validBindings(), MERGE_AUDIT_DISCORD_WEBHOOK_URL: webhookUrl });
    }).toThrow("MERGE_AUDIT_DISCORD_WEBHOOK_URL must use https://discord.com/api/webhooks/{id}/{token}");
  });

  it("正しい Discord Webhook URL を受け入れる", () => {
    expect(() => {
      validateEnv({
        ...validBindings(),
        MERGE_AUDIT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/token_-value",
      });
    }).not.toThrow();
  });

  it("不正な TTL を拒否する", () => {
    expect(() => {
      validateEnv({ ...validBindings(), MERGE_COOLDOWN_SECONDS: "0" });
    }).toThrow("MERGE_COOLDOWN_SECONDS must be a positive integer");
  });
});
