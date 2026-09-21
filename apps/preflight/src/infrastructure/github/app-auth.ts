import { importPKCS8, SignJWT } from "jose";

import { AppError } from "../../errors.js";

// isolate 内で env の秘密鍵は不変なので、平文 PEM を保持せず非抽出な CryptoKey の promise だけを cache する
// 変化検知は正規化済み PEM の SHA-256 hex を discriminator に使い、秘密そのものを request scope 外へ残さない
let cachedPrivateKey: { fingerprint: string; promise: Promise<CryptoKey> } | undefined;

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const importPrivateKey = async (privateKeyPem: string): Promise<CryptoKey> => {
  const normalizedPem = privateKeyPem.replace(/\\n/g, "\n").trim();
  const fingerprint = await sha256Hex(normalizedPem);
  if (cachedPrivateKey?.fingerprint === fingerprint) return cachedPrivateKey.promise;

  const promise = importPKCS8(normalizedPem, "RS256");
  cachedPrivateKey = { fingerprint, promise };
  return promise;
};

export const createGitHubAppJwt = async (input: {
  appId: string;
  privateKeyPem: string;
  now?: Date;
}): Promise<string> => {
  const nowInSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);

  try {
    const privateKey = await importPrivateKey(input.privateKeyPem);
    return await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(input.appId)
      .setIssuedAt(nowInSeconds - 60)
      .setExpirationTime(nowInSeconds + 540)
      .sign(privateKey);
  } catch {
    throw new AppError("GITHUB_AUTH_FAILED", 502, "GitHub App JWT could not be generated");
  }
};
