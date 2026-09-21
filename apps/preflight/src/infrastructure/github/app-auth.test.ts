import * as jose from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createGitHubAppJwt } from "./app-auth.js";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const createTestPrivateKey = async (): Promise<string> => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const exportedPrivateKey = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const privateKey = new Uint8Array(exportedPrivateKey as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(privateKey)}\n-----END PRIVATE KEY-----`;
};

describe("createGitHubAppJwt", () => {
  let privateKeyPem: string;

  beforeAll(async () => {
    privateKeyPem = await createTestPrivateKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RS256 で iss と有効期間を制限した JWT を作る", async () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const nowInSeconds = Math.floor(now.getTime() / 1000);
    const jwt = await createGitHubAppJwt({ appId: "12345", privateKeyPem, now });
    const payload = jose.decodeJwt(jwt);

    expect(jose.decodeProtectedHeader(jwt)).toMatchObject({ alg: "RS256" });
    expect(payload).toMatchObject({ iss: "12345", iat: nowInSeconds - 60, exp: nowInSeconds + 540 });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(600);
  });

  it("改行を \\n へ escape した PKCS#8 の秘密鍵を受け入れる", async () => {
    await expect(
      createGitHubAppJwt({ appId: "12345", privateKeyPem: privateKeyPem.replace(/\n/g, "\\n") })
    ).resolves.toContain(".");
  });

  it("秘密鍵が別なら cache した鍵を流用せず、異なる署名を返す", async () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const otherPrivateKeyPem = await createTestPrivateKey();
    const first = await createGitHubAppJwt({ appId: "12345", privateKeyPem, now });
    const second = await createGitHubAppJwt({ appId: "12345", privateKeyPem: otherPrivateKeyPem, now });

    // 別鍵で異なる署名になるので、cache が最初の鍵を流用せず秘密ごとに変化検知していることを示す
    expect(first).not.toBe(second);
  });

  it("不正な秘密鍵の内容を error message に出さない", async () => {
    const secret = "SECRET_PRIVATE_KEY_CONTENT";
    try {
      await createGitHubAppJwt({ appId: "12345", privateKeyPem: secret });
      throw new Error("Expected createGitHubAppJwt to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "GITHUB_AUTH_FAILED" });
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
  });

  it("同じ秘密鍵なら import は 1 回だけで、以降は cache した CryptoKey で署名する", async () => {
    // fresh key なので module scope の cache には未登録で、確実に cold から始まる
    const pem = await createTestPrivateKey();
    const now = new Date("2026-07-16T00:00:00.000Z");
    const importSpy = vi.spyOn(jose, "importPKCS8");

    await createGitHubAppJwt({ appId: "12345", privateKeyPem: pem, now });
    await createGitHubAppJwt({ appId: "12345", privateKeyPem: pem, now });
    await createGitHubAppJwt({ appId: "12345", privateKeyPem: pem, now });

    // cache が消えれば 3 回 import される
    // 1 回だけなのは fingerprint 一致で CryptoKey promise を再利用しているから
    expect(importSpy).toHaveBeenCalledTimes(1);
  });

  it("秘密鍵が変わったら import し直して cache を差し替える", async () => {
    const keyA = await createTestPrivateKey();
    const keyB = await createTestPrivateKey();
    const now = new Date("2026-07-16T00:00:00.000Z");
    const importSpy = vi.spyOn(jose, "importPKCS8");

    const signedWithA = await createGitHubAppJwt({ appId: "12345", privateKeyPem: keyA, now });
    const signedWithBFirst = await createGitHubAppJwt({ appId: "12345", privateKeyPem: keyB, now });
    const signedWithBAgain = await createGitHubAppJwt({ appId: "12345", privateKeyPem: keyB, now });

    // keyA→keyB で cache miss が 2 回、直後の keyB は hit で import されない
    expect(importSpy).toHaveBeenCalledTimes(2);
    // fingerprint が変われば cache を破棄して新しい鍵で署名する（keyA の CryptoKey を stale に流用しない）
    expect(signedWithBFirst).not.toBe(signedWithA);
    // 同じ keyB は決定的な RS256 で同一署名になり、cache hit でも署名が壊れない
    expect(signedWithBAgain).toBe(signedWithBFirst);
  });
});
