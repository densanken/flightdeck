const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

const decodeHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
};

// GitHub の Webhook の X-Hub-Signature-256（HMAC-SHA256）を、受け取ったままの body で検証する
// 比較は crypto.subtle.verify が行い、時間差で一致の度合いを漏らさない
export const verifyGitHubWebhookSignature = async (input: {
  rawBody: Uint8Array;
  signatureHeader: string;
  secret: string;
}): Promise<boolean> => {
  const match = SIGNATURE_PATTERN.exec(input.signatureHeader);
  if (!match?.[1]) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify("HMAC", key, decodeHex(match[1]), input.rawBody);
};
