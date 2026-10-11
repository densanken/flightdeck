const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
};

const MAX_TIMESTAMP_AGE_SECONDS = 300;

export const verifyDiscordSignature = async (
  publicKeyHex: string,
  signature: string,
  timestamp: string,
  body: string
): Promise<boolean> => {
  try {
    const timestampNum = Number(timestamp);
    if (isNaN(timestampNum)) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - timestampNum);
    if (age > MAX_TIMESTAMP_AGE_SECONDS) return false;

    const publicKey = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, [
      "verify",
    ]);
    const signatureBytes = hexToBytes(signature);
    const message = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify("Ed25519", publicKey, signatureBytes, message);
  } catch {
    return false;
  }
};
