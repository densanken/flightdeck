import { describe, expect, it } from "vitest";

import { getGitHubAuthConfig, getRuntimeOptions, getWebhookSecret, parseGitHubAppBotUserId } from "./env.js";

describe("環境変数の読み取り", () => {
  it("空でない webhook secret を trim せずそのまま返す", () => {
    expect(getWebhookSecret({ GITHUB_WEBHOOK_SECRET: " secret with spaces " })).toBe(" secret with spaces ");
  });

  it("未設定と不正な key を、値を含めずに報告する", () => {
    expect(() => getGitHubAuthConfig({})).toThrow(
      expect.objectContaining({ configKey: "GITHUB_APP_ID", reason: "missing" })
    );
    expect(() => getRuntimeOptions({ SKIP_BOTS: "not-a-secret-but-invalid" })).toThrow(
      expect.objectContaining({ configKey: "SKIP_BOTS", reason: "invalid" })
    );
    try {
      getRuntimeOptions({ SKIP_BOTS: "not-a-secret-but-invalid" });
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("not-a-secret-but-invalid");
    }
  });

  it("GitHub App の bot user ID を数値として parse し、未設定と小数を拒否する", () => {
    expect(parseGitHubAppBotUserId(" 123456789 ")).toBe(123456789);
    expect(() => parseGitHubAppBotUserId(undefined)).toThrow(
      expect.objectContaining({ configKey: "GITHUB_APP_BOT_USER_ID", reason: "missing" })
    );
    expect(() => parseGitHubAppBotUserId("1.5")).toThrow(
      expect.objectContaining({ configKey: "GITHUB_APP_BOT_USER_ID", reason: "invalid" })
    );
  });

  it.each(["", "   "])("空文字と空白だけの webhook secret %j を missing として拒否する", (value) => {
    expect(() => getWebhookSecret({ GITHUB_WEBHOOK_SECRET: value })).toThrow(
      expect.objectContaining({ configKey: "GITHUB_WEBHOOK_SECRET", reason: "missing" })
    );
  });

  it("GitHub 認証の 2 値を trim して読み取り、private key の未設定を拒否する", () => {
    expect(getGitHubAuthConfig({ GITHUB_APP_ID: " 123 ", GITHUB_PRIVATE_KEY: " pem " })).toEqual({
      appId: "123",
      privateKeyPem: "pem",
    });
    expect(() => getGitHubAuthConfig({ GITHUB_APP_ID: "123" })).toThrow(
      expect.objectContaining({ configKey: "GITHUB_PRIVATE_KEY", reason: "missing" })
    );
  });

  it.each([undefined, ""])("delivery cache TTL が %j のときは既定値を使う", (value) => {
    expect(getRuntimeOptions({ DELIVERY_CACHE_TTL_SECONDS: value }).deliveryCacheTtlSeconds).toBe(86_400);
  });

  it.each(["abc", "0", "-10", "9007199254740993"])("範囲外の delivery cache TTL %j を拒否する", (value) => {
    expect(() => getRuntimeOptions({ DELIVERY_CACHE_TTL_SECONDS: value })).toThrow(
      expect.objectContaining({ configKey: "DELIVERY_CACHE_TTL_SECONDS", reason: "invalid" })
    );
  });

  it("有効な DELIVERY_CACHE_TTL_SECONDS, SKIP_BOTS, LOG_LEVEL を parse する", () => {
    expect(getRuntimeOptions({ DELIVERY_CACHE_TTL_SECONDS: "3600", SKIP_BOTS: "true", LOG_LEVEL: "debug" })).toEqual({
      deliveryCacheTtlSeconds: 3600,
      skipBots: true,
      logLevel: "debug",
    });
    expect(getRuntimeOptions({ SKIP_BOTS: "false" }).skipBots).toBe(false);
  });

  it("不正な LOG_LEVEL を拒否する", () => {
    expect(() => getRuntimeOptions({ LOG_LEVEL: "verbose" })).toThrow(
      expect.objectContaining({ configKey: "LOG_LEVEL", reason: "invalid" })
    );
  });

  it.each(["0", "-5", "abc", "9007199254740993"])("範囲外の bot user ID %j を拒否する", (value) => {
    expect(() => parseGitHubAppBotUserId(value)).toThrow(
      expect.objectContaining({ configKey: "GITHUB_APP_BOT_USER_ID", reason: "invalid" })
    );
  });
});
