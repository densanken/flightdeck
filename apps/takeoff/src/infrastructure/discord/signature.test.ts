import { describe, expect, it } from "vitest";

import { verifyDiscordSignature } from "./signature.js";

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

interface Ed25519KeyPair {
  publicKeyHex: string;
  privateKey: CryptoKey;
}

const generateKeyPair = async (): Promise<Ed25519KeyPair> => {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("publicKey" in keyPair)) throw new Error("Expected a CryptoKeyPair");
  const exportedPublicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  if (!(exportedPublicKey instanceof ArrayBuffer)) throw new Error("Expected a raw public key");
  return {
    publicKeyHex: bytesToHex(exportedPublicKey),
    privateKey: keyPair.privateKey,
  };
};

const signMessage = async (privateKey: CryptoKey, timestamp: string, body: string): Promise<string> => {
  const message = new TextEncoder().encode(timestamp + body);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
  return bytesToHex(signature);
};

const currentTimestamp = (): string => String(Math.floor(Date.now() / 1000));

describe("verifyDiscordSignature", () => {
  it("有効な Ed25519 署名を検証する", async () => {
    const { publicKeyHex, privateKey } = await generateKeyPair();
    const body = '{"type":1}';
    const timestamp = currentTimestamp();
    const signature = await signMessage(privateKey, timestamp, body);

    const result = await verifyDiscordSignature(publicKeyHex, signature, timestamp, body);
    expect(result).toBe(true);
  });

  it("不正な署名を拒否する", async () => {
    const { publicKeyHex } = await generateKeyPair();
    const invalidSignature = "00".repeat(64);
    const body = '{"type":1}';
    const timestamp = currentTimestamp();

    const result = await verifyDiscordSignature(publicKeyHex, invalidSignature, timestamp, body);
    expect(result).toBe(false);
  });

  it("タイムスタンプが 300 秒を超えた場合に拒否する", async () => {
    const { publicKeyHex, privateKey } = await generateKeyPair();
    const body = '{"type":1}';
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const signature = await signMessage(privateKey, oldTimestamp, body);

    const result = await verifyDiscordSignature(publicKeyHex, signature, oldTimestamp, body);
    expect(result).toBe(false);
  });

  it("不正な timestamp（非数値）で false を返す", async () => {
    const { publicKeyHex, privateKey } = await generateKeyPair();
    const body = '{"type":1}';
    const invalidTimestamp = "not-a-number";
    const signature = await signMessage(privateKey, invalidTimestamp, body);

    const result = await verifyDiscordSignature(publicKeyHex, signature, invalidTimestamp, body);
    expect(result).toBe(false);
  });
});
