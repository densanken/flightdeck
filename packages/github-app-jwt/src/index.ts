import { SignJWT } from "jose";

import { importPrivateKey } from "./private-key.js";

/**
 * GitHub App として API を呼ぶための JWT を PKCS#8 の秘密鍵で署名する
 * 失敗時の error は呼び出し側で各 app の error 型へ変換し、秘密鍵の内容を message に含めない
 */
export const createGitHubAppJwt = async (input: {
  appId: string;
  privateKeyPem: string;
  now?: Date;
}): Promise<string> => {
  const nowInSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const privateKey = await importPrivateKey(input.privateKeyPem);
  // 時計のずれを吸収するため iat を 60 秒戻し、有効期間を GitHub の上限 10 分に収める
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(input.appId)
    .setIssuedAt(nowInSeconds - 60)
    .setExpirationTime(nowInSeconds + 540)
    .sign(privateKey);
};
