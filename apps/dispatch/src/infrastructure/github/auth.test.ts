import { describe, expect, it } from "vitest";

import { GitHubInstallationTokenProvider } from "./auth.js";

import type { Fetcher } from "./request.js";

const createPrivateKey = async (): Promise<string> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const exported = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...exported))}\n-----END PRIVATE KEY-----`;
};

describe("GitHubInstallationTokenProvider", () => {
  const installation = { owner: "event", id: 1 };
  const create = async (fetcher: Fetcher) => {
    const provider = new GitHubInstallationTokenProvider({
      fetcher,
      appId: "1",
      privateKeyPem: await createPrivateKey(),
      installation,
    });

    return (repository: string) => provider.getToken(repository);
  };
  const recording = () => {
    const requests: { key: string; authorization: string | null }[] = [];
    const fetcher: Fetcher = (url, init) => {
      const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
      requests.push({ key, authorization: new Headers(init.headers).get("authorization") });
      if (key === "GET /repos/other/a/installation") return Promise.resolve(Response.json({ id: 42 }));
      if (key === "POST /app/installations/42/access_tokens")
        return Promise.resolve(Response.json({ token: "ghs_42" }));
      if (key === "POST /app/installations/1/access_tokens") return Promise.resolve(Response.json({ token: "ghs_1" }));
      return Promise.resolve(new Response("", { status: 500 }));
    };
    return { requests, fetcher };
  };

  it("event の repository は、Webhook の Installation ID から token を発行し、Installation を探さない", async () => {
    const { requests, fetcher } = recording();
    const getToken = await create(fetcher);

    await expect(getToken("event/repo")).resolves.toBe("ghs_1");
    await expect(getToken("Event/other-repo")).resolves.toBe("ghs_1");

    expect(requests.map((request) => request.key)).toEqual(["POST /app/installations/1/access_tokens"]);
    expect(requests[0]?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("別の owner は owner ごとに、最初に見た repository で Installation を 1 回だけ探し、同じ owner の repository では token も使い回す", async () => {
    const { requests, fetcher } = recording();
    const getToken = await create(fetcher);

    await getToken("other/a");
    await getToken("Other/b");

    expect(requests.map((request) => request.key)).toEqual([
      "GET /repos/other/a/installation",
      "POST /app/installations/42/access_tokens",
    ]);
  });

  it("JWT は provider ごとに 1 回だけ作る", async () => {
    const authorizations = new Set<string | null>();
    const fetcher: Fetcher = (url, init) => {
      authorizations.add(new Headers(init.headers).get("authorization"));
      if (new URL(url).pathname.endsWith("/installation")) return Promise.resolve(Response.json({ id: 42 }));
      return Promise.resolve(Response.json({ token: "ghs_x" }));
    };
    const getToken = await create(fetcher);

    await getToken("other/a");
    await getToken("third/b");

    expect(authorizations.size).toBe(1);
  });

  it("App がインストールされていない owner は、owner 名つきの permission エラーにする", async () => {
    const getToken = await create(() => Promise.resolve(new Response("", { status: 404 })));

    await expect(getToken("nobody/p")).rejects.toMatchObject({
      kind: "permission",
      message: "GitHub App is not installed: nobody/p",
    });
  });

  it("秘密鍵が不正なら、鍵の内容を含めず permission エラーにする", async () => {
    const provider = new GitHubInstallationTokenProvider({
      fetcher: () => Promise.resolve(new Response("", { status: 500 })),
      appId: "1",
      privateKeyPem: "not-a-key-secret",
      installation,
    });
    const getToken = (repository: string) => provider.getToken(repository);

    const error = await getToken("event/repo").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "permission" });
    expect((error as Error).message).not.toContain("not-a-key-secret");
  });
});
