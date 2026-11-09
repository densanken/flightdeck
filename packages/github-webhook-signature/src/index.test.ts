import { describe, expect, it } from "vitest";

import { verifyGitHubWebhookSignature } from "./index.js";

const signBytes = async (secret: string, body: Uint8Array): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, body);
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const sign = async (secret: string, body: string): Promise<string> => signBytes(secret, encode(body));

describe("verifyGitHubWebhookSignature", () => {
  const secret = "webhook-secret";
  const body = '{"action":"opened"}';

  it("正しい署名を受け入れる", async () => {
    await expect(
      verifyGitHubWebhookSignature({ rawBody: encode(body), signatureHeader: await sign(secret, body), secret })
    ).resolves.toBe(true);
  });

  it("body が改変された署名を拒否する", async () => {
    await expect(
      verifyGitHubWebhookSignature({ rawBody: encode(`${body} `), signatureHeader: await sign(secret, body), secret })
    ).resolves.toBe(false);
  });

  it("異なる secret で作られた署名を拒否する", async () => {
    await expect(
      verifyGitHubWebhookSignature({ rawBody: encode(body), signatureHeader: await sign("other-secret", body), secret })
    ).resolves.toBe(false);
  });

  it.each(["", "00", `sha1=${"0".repeat(40)}`, `sha256=${"z".repeat(64)}`, `sha256=${"0".repeat(62)}`])(
    "形式が不正な署名 %j を拒否する",
    async (signatureHeader) => {
      await expect(verifyGitHubWebhookSignature({ rawBody: encode(body), signatureHeader, secret })).resolves.toBe(
        false
      );
    }
  );

  it("Unicode を含む body の UTF-8 の byte 列を検証する", async () => {
    const unicodeBody = '{"message":"こんにちは🌏"}';
    await expect(
      verifyGitHubWebhookSignature({
        rawBody: encode(unicodeBody),
        signatureHeader: await sign(secret, unicodeBody),
        secret,
      })
    ).resolves.toBe(true);
  });

  it("UTF-8 でない byte 列の body も検証する", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xfa, 0xfb, 0xff]);
    await expect(
      verifyGitHubWebhookSignature({ rawBody: bytes, signatureHeader: await signBytes(secret, bytes), secret })
    ).resolves.toBe(true);
  });

  it("末尾 1 byte を改変した raw byte の body を拒否する", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xfa, 0xfb, 0xff]);
    const signatureHeader = await signBytes(secret, bytes);
    const tampered = new Uint8Array(bytes);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0x01;
    await expect(verifyGitHubWebhookSignature({ rawBody: tampered, signatureHeader, secret })).resolves.toBe(false);
  });
});
