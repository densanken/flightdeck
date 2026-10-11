import { describe, it, expect } from "vitest";

import { redactSecretsInLog } from "./logger";

describe("redactSecretsInLog", () => {
  it("GitHub token を秘匿化する", () => {
    const msg = "token: ghs_1234567890abcdefghijklmnopqrstuvwxyz12";
    expect(redactSecretsInLog(msg)).not.toContain("ghs_");
  });

  it("Bearer token を秘匿化する", () => {
    const msg = "Authorization: Bearer abc123secrettoken";
    const result = redactSecretsInLog(msg);
    expect(result).toContain("Bearer");
    expect(result).toContain("<redacted>");
    expect(result).not.toContain("abc123secrettoken");
  });

  it("Discord Bot token を秘匿化する", () => {
    const msg = "Authorization: Bot discord-secret-token";
    expect(redactSecretsInLog(msg)).toBe("Authorization: Bot <redacted>");
  });

  it("PEM private key を秘匿化する", () => {
    const msg = "key: -----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    expect(redactSecretsInLog(msg)).not.toContain("MIIE");
  });

  it("Discord webhook URL の token を秘匿化する", () => {
    const msg = "url: https://discord.com/api/webhooks/123456/secrettoken123";
    const result = redactSecretsInLog(msg);
    expect(result).toContain("webhooks/123456/");
    expect(result).not.toContain("secrettoken123");
  });

  it("秘密情報を含まないメッセージはそのまま返す", () => {
    const msg = "GET /health 200 5ms";
    expect(redactSecretsInLog(msg)).toBe(msg);
  });
});
