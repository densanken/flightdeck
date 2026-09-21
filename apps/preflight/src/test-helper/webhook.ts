export const TEST_WEBHOOK_SECRET = "test-webhook-secret";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const createTestPrivateKey = async (): Promise<string> => {
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
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(new Uint8Array(exported as ArrayBuffer))}\n-----END PRIVATE KEY-----`;
};

const sign = async (body: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(TEST_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
};

export const pullRequestBody = (
  overrides: {
    action?: string;
    author?: string;
    authorType?: string;
    assignees?: string[];
    title?: string;
    headSha?: string;
    titleChanged?: boolean;
  } = {}
): string =>
  JSON.stringify({
    action: overrides.action ?? "opened",
    changes: overrides.titleChanged ? { title: { from: "old title" } } : undefined,
    installation: { id: 42 },
    repository: { name: "repo", owner: { login: "owner" } },
    pull_request: {
      number: 7,
      title: overrides.title ?? "feat: add auto assignment",
      head: { sha: overrides.headSha ?? "abc123" },
      user: { login: overrides.author ?? "author", type: overrides.authorType ?? "User" },
      assignees: (overrides.assignees ?? []).map((login) => ({ login })),
    },
  });

export const webhookRequest = async (body: string, deliveryId = "delivery-1"): Promise<Request> =>
  new Request("https://worker.example.com/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": deliveryId,
      "X-Hub-Signature-256": await sign(body),
    },
    body,
  });
