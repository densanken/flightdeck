import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cachedPrivateKeyEntry } from "./private-key.js";

import { createGitHubAppJwt } from "./index.js";

const createTestKeyPair = async (): Promise<{ privateKeyPem: string; publicKey: CryptoKey }> => {
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
  const exported = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
};

const now = new Date("2026-07-16T00:00:00.000Z");
const nowInSeconds = Math.floor(now.getTime() / 1000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGitHubAppJwt", () => {
  it("RS256 で署名し、iss と 10 分以内の有効期間を設定する", async () => {
    const { privateKeyPem, publicKey } = await createTestKeyPair();

    const jwt = await createGitHubAppJwt({ appId: "12345", privateKeyPem, now });

    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "RS256" });
    expect(decodeJwt(jwt)).toMatchObject({ iss: "12345", iat: nowInSeconds - 60, exp: nowInSeconds + 540 });
    await expect(jwtVerify(jwt, publicKey, { currentDate: now })).resolves.toBeDefined();
  });

  it("改行を \\n へ escape した秘密鍵を受け入れる", async () => {
    const { privateKeyPem, publicKey } = await createTestKeyPair();

    const jwt = await createGitHubAppJwt({ appId: "12345", privateKeyPem: privateKeyPem.replace(/\n/g, "\\n"), now });

    await expect(jwtVerify(jwt, publicKey, { currentDate: now })).resolves.toBeDefined();
  });

  it("PKCS#8 でない秘密鍵は reject する", async () => {
    await expect(createGitHubAppJwt({ appId: "12345", privateKeyPem: "not a key" })).rejects.toThrow();
  });

  it("同じ秘密鍵は 1 回だけ import する", async () => {
    // fresh key なので module scope の cache には未登録で、確実に cold から始まる
    const { privateKeyPem } = await createTestKeyPair();
    const importKeySpy = vi.spyOn(crypto.subtle, "importKey");

    await createGitHubAppJwt({ appId: "12345", privateKeyPem, now });
    await createGitHubAppJwt({ appId: "12345", privateKeyPem, now });

    expect(importKeySpy).toHaveBeenCalledTimes(1);
  });

  it("cache には平文 PEM を残さず、正規化した PEM の SHA-256 指紋と抽出できない CryptoKey だけを保持する", async () => {
    const { privateKeyPem } = await createTestKeyPair();

    await createGitHubAppJwt({ appId: "12345", privateKeyPem: privateKeyPem.replace(/\n/g, "\\n"), now });

    const entry = cachedPrivateKeyEntry();
    expect(Object.keys(entry ?? {}).sort()).toEqual(["fingerprint", "promise"]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateKeyPem));
    const expectedFingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
    expect(entry?.fingerprint).toBe(expectedFingerprint);
    const key = await entry?.promise;
    expect(key?.extractable).toBe(false);
  });

  it("秘密鍵が変わったら import し直し、新しい鍵で署名する", async () => {
    const keyA = await createTestKeyPair();
    const keyB = await createTestKeyPair();
    const importKeySpy = vi.spyOn(crypto.subtle, "importKey");

    await createGitHubAppJwt({ appId: "12345", privateKeyPem: keyA.privateKeyPem, now });
    const signedWithB = await createGitHubAppJwt({ appId: "12345", privateKeyPem: keyB.privateKeyPem, now });

    expect(importKeySpy).toHaveBeenCalledTimes(2);
    await expect(jwtVerify(signedWithB, keyB.publicKey, { currentDate: now })).resolves.toBeDefined();
    await expect(jwtVerify(signedWithB, keyA.publicKey, { currentDate: now })).rejects.toThrow();
  });
});
