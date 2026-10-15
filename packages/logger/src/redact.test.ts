import { describe, it, expect } from "vitest";

import { redactSecrets } from "./index.js";

describe("redactSecrets", () => {
  it("GitHub token を秘匿化する", () => {
    const msg = "token: ghs_1234567890abcdefghijklmnopqrstuvwxyz12";
    expect(redactSecrets(msg)).not.toContain("ghs_");
  });

  it("Bearer token を秘匿化する", () => {
    const msg = "Authorization: Bearer abc123secrettoken456789";
    const result = redactSecrets(msg);
    expect(result).toContain("Bearer");
    expect(result).toContain("<redacted>");
    expect(result).not.toContain("abc123secrettoken456789");
  });

  it("Discord Bot token を秘匿化する", () => {
    const msg = "Authorization: Bot discord-secret-token";
    expect(redactSecrets(msg)).toBe("Authorization: Bot <redacted>");
  });

  it("PEM private key を秘匿化する", () => {
    const msg = "key: -----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(msg)).not.toContain("MIIE");
  });

  it("Discord webhook URL の token を秘匿化する", () => {
    const msg = "url: https://discord.com/api/webhooks/123456/secrettoken123";
    const result = redactSecrets(msg);
    expect(result).toContain("webhooks/123456/");
    expect(result).not.toContain("secrettoken123");
  });

  it("小文字の bearer やタブ区切りの credential も秘匿化する", () => {
    expect(redactSecrets("Authorization: bearer abcdefghijklmnopqrstuvwxyz0123")).toBe(
      "Authorization: bearer <redacted>"
    );
    expect(redactSecrets("Authorization: Bearer\tabcdefghijklmnopqrstuvwxyz0123")).toBe(
      "Authorization: Bearer\t<redacted>"
    );
  });

  it("文中の token や Bot に続く通常の単語は秘匿化しない", () => {
    const msg = "A JSON web token could not be decoded by the Bot account";
    expect(redactSecrets(msg)).toBe(msg);
  });

  it("Bot や token を語の一部に含む単語は秘匿化しない", () => {
    const msg = "robot users requested a retoken flow";
    expect(redactSecrets(msg)).toBe(msg);
  });

  it("秘密情報を含まないメッセージはそのまま返す", () => {
    const msg = "GET /health 200 5ms";
    expect(redactSecrets(msg)).toBe(msg);
  });
});
