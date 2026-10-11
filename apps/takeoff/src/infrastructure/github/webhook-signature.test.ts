import { describe, expect, it } from "vitest";

import { verifyGitHubWebhookSignature } from "./webhook-signature.js";

const computeSignature = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
};

describe("verifyGitHubWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const body = '{"action":"opened"}';

  it("正しい署名で true を返す", async () => {
    const signature = await computeSignature(secret, body);
    const result = await verifyGitHubWebhookSignature(secret, signature, body);
    expect(result).toBe(true);
  });

  it("不正な署名で false を返す", async () => {
    const signature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    const result = await verifyGitHubWebhookSignature(secret, signature, body);
    expect(result).toBe(false);
  });

  it("sha256= プレフィックスがない場合 false を返す", async () => {
    const signature = "invalid-signature-without-prefix";
    const result = await verifyGitHubWebhookSignature(secret, signature, body);
    expect(result).toBe(false);
  });

  it("空の body で正しい署名を検証する", async () => {
    const emptyBody = "";
    const signature = await computeSignature(secret, emptyBody);
    const result = await verifyGitHubWebhookSignature(secret, signature, emptyBody);
    expect(result).toBe(true);
  });
});
