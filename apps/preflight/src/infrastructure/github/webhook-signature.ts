const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

const decodeHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const verifyWebhookSignature = async (input: {
  rawBody: string | Uint8Array;
  signatureHeader: string;
  secret: string;
}): Promise<boolean> => {
  const match = SIGNATURE_PATTERN.exec(input.signatureHeader);
  if (!match?.[1]) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const rawBody = typeof input.rawBody === "string" ? encoder.encode(input.rawBody) : input.rawBody;
  return crypto.subtle.verify("HMAC", key, decodeHex(match[1]), rawBody);
};
