import { logger } from "hono/logger";

const SECRET_PATTERNS = [
  // GitHub token (ghp_, ghs_, gho_, ghu_, ghr_)
  /\b(ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9_]{36,}\b/g,
  // header に載る Bearer, Bot, token 形式の値
  /((?:Bearer|Bot|token)\s+)[^\s"]+/gi,
  // PEM 形式の秘密鍵の本文
  /-----BEGIN[\s\S]*?END[^-]*-----/g,
  // token を含む Discord Webhook URL
  /(https:\/\/discord\.com\/api(?:\/v\d+)?\/webhooks\/[^/\s"]+\/)[^/\s"]+/g,
  // Ed25519 署名 (hex 128 文字 = 64 byte)
  /(x-signature-ed25519:\s*)[0-9a-f]{128}/gi,
];

export const redactSecretsInLog = (message: string): string => {
  let result = message;
  for (const pattern of SECRET_PATTERNS) {
    // SECRET_PATTERNS は module scope で共有する正規表現のため、走査前に lastIndex を 0 へ戻しておく
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && match.startsWith(prefix)) {
        return `${prefix}<redacted>`;
      }
      return "<redacted>";
    });
  }
  return result;
};

export const redactingLogger = () =>
  logger((message: string, ...rest: string[]) => {
    console.log(redactSecretsInLog(message), ...rest);
  });
