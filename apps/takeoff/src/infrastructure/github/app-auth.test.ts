import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createGitHubAppJwt, GitHubAppAuthImpl } from "./app-auth.js";
import { GitHubError } from "./client.js";
import { cacheKeys } from "../cache/keys.js";
import { workersCache } from "../cache/workers-api.js";

// GitHub が生成する鍵は PKCS#1（BEGIN RSA PRIVATE KEY）だが、実装が読み込めるのは PKCS#8 のみ
// この test 鍵は PKCS#1 形式が拒否されることを確認する用途だけに使う（実在の秘密鍵ではない使い捨ての test fixture）
const PKCS1_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC29aJITrF2GUqGUFD+dCuHqK4DlzB0gPJ43J5Usqkeq3fY9RV7
pwfC+gb4Af3nfwQzs+ttOp71/ssvkIVdzIhNYyAxalxZ9nQZzRYKWR/O4tiq0VsF
t+BDGgUQaa4gXCPYzXpmQxhxb0miR/vmxuTsUmz5S7kT/GMeisjPsS4jIwIDAQAB
AoGBAI/TUwpiilDbmuExPCp7qkiPipQaAyZiw7nNPM46UIZipukv6P52lLxqjpXi
AvY7vFLkqjsIrTOWY6X1h1HwWmifMkFs8bY+ZGoAF2uw0uOBWEbj67eCy5QANLt0
WaHFyZ3rE2JIB2bV9/GWLG8Poy+qLuDhTj3TQuy31dUYkoxxAkEA2aiLgCsXOPih
MPoi1vJ9obzDVELBHgeS1nMaCR1aUsOuGj0+Uba5rgBK7UCZR042uinOqsPGD2s3
1eOqOld/qQJBANcwUcShecHB4/LRERLErDiteJvGjg+K7dTYqyfMfGX4xwXRYDIC
uGi6tkwbj9MlmPswNE//Pehu0L6htjrwO+sCQQC5JqPMWlt9zhoodI+Qc2SlYdJy
6fonFmA1ZmI+YKbGAskmbvSFRD+9IWibW7lHq+PoBspT/weLdDRiETFsQaRJAkAM
92dl7sj0aOeAYSKjO+CYxbMnx84Vl6x/D9M4YbT5PAVaD2S5frp37RBBA8Ql1/Ug
5aWxUFL9p3fClOHzKTijAkBLYvJoigYE6qmyyiv/J1kUN821oVhyc/q5loVHrUlU
fioi1l1ZM1eji1s90ZDdH4L6hdvID6FpksPfGmNPDpYZ
-----END RSA PRIVATE KEY-----`;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const createTestPrivateKeyPkcs8 = async (): Promise<string> => {
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

const jsonResponse = (value: unknown, status = 200): Response => {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GitHub App authentication", () => {
  let pkcs8PrivateKey: string;

  beforeAll(async () => {
    pkcs8PrivateKey = await createTestPrivateKeyPkcs8();
  });

  // 署名と秘密鍵の cache は @flightdeck/github-app-jwt で検証する
  it("PKCS#1 秘密鍵はエラーになる", async () => {
    await expect(createGitHubAppJwt("12345", PKCS1_PRIVATE_KEY)).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });

  it("壊れた秘密鍵のエラーへ秘密鍵本文を含めない", async () => {
    const secret = "SECRET_PRIVATE_KEY_CONTENT";

    await expect(createGitHubAppJwt("12345", secret)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GitHubError);
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
      return true;
    });
  });

  it("installation token の rate limit を GitHubError へ変換する", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"message":"rate limit exceeded"}', {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      })
    );
    const auth = new GitHubAppAuthImpl(fetcher);

    await expect(auth.getInstallationToken("jwt", 1, "https://rate-limit-test.invalid")).rejects.toMatchObject({
      type: "github_rate_limited",
      statusCode: 503,
    });
  });

  it("既定 fetch を不正な this receiver で呼び出さない", async () => {
    const originalFetch = globalThis.fetch;
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse({ id: 999, app_id: 12345 }));
    }) as typeof fetch;
    globalThis.fetch = receiverSensitiveFetch;

    try {
      const auth = new GitHubAppAuthImpl();
      await expect(
        auth.getInstallationId("jwt", "12345", "org", "https://default-fetch-binding-test.invalid")
      ).resolves.toBe(999);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
  });

  it("installation token を有効期限内は cache から再利用する", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 999, app_id: 12345 }))
      .mockResolvedValueOnce(
        jsonResponse({ token: "installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() })
      );
    const auth = new GitHubAppAuthImpl(fetcher);
    const cacheBaseUrl = "https://installation-token-cache-test.invalid";

    await expect(auth.getAuthenticatedToken("12345", pkcs8PrivateKey, "org", cacheBaseUrl)).resolves.toBe(
      "installation-token"
    );
    await expect(auth.getAuthenticatedToken("12345", pkcs8PrivateKey, "org", cacheBaseUrl)).resolves.toBe(
      "installation-token"
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("installation token を Cache API（workersCache）へ書き込まない", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 111, app_id: 12345 }))
      .mockResolvedValueOnce(
        jsonResponse({ token: "memory-only-token", expires_at: new Date(Date.now() + 3600_000).toISOString() })
      );
    const auth = new GitHubAppAuthImpl(fetcher);
    const cacheBaseUrl = "https://installation-token-memory-only-test.invalid";

    await expect(auth.getAuthenticatedToken("12345", pkcs8PrivateKey, "org", cacheBaseUrl)).resolves.toBe(
      "memory-only-token"
    );

    const cacheKey = cacheKeys.installationToken(cacheBaseUrl, 111);
    await expect(workersCache.get(cacheKey, z.string())).resolves.toBeNull();
  });

  it("有効期限が近い installation token を memory cache へ固定 TTL で載せず、失効後に再発行する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 777, app_id: 12345 }))
      // 残り 90 秒（安全マージン 60 秒を引くと memory TTL は 30 秒）の token
      .mockResolvedValueOnce(
        jsonResponse({ token: "token-1", expires_at: new Date(Date.now() + 90_000).toISOString() })
      )
      .mockResolvedValueOnce(
        jsonResponse({ token: "token-2", expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      );
    const auth = new GitHubAppAuthImpl(fetcher);
    const cacheBaseUrl = "https://installation-token-shortlived.invalid";

    await expect(auth.getAuthenticatedToken("12345", pkcs8PrivateKey, "org", cacheBaseUrl)).resolves.toBe("token-1");

    // memory TTL（30 秒）を超えて token の有効期限も過ぎたので、stale な token を返さず再発行する
    vi.advanceTimersByTime(31_000);
    await expect(auth.getAuthenticatedToken("12345", pkcs8PrivateKey, "org", cacheBaseUrl)).resolves.toBe("token-2");

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("古い installation ID の token 発行が 404 なら両 cache を消して新しい ID から一度だけ再試行する", async () => {
    const cacheBaseUrl = "https://stale-installation-id-recovery.invalid";
    const installationIdCacheKey = cacheKeys.installationId(cacheBaseUrl, "12345", "org");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 111, app_id: 12345 }))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ id: 222, app_id: 12345 }))
      .mockResolvedValueOnce(
        jsonResponse({ token: "new-installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() })
      );
    const auth = new GitHubAppAuthImpl(fetcher);

    await expect(auth.getInstallationId("jwt", "12345", "org", cacheBaseUrl)).resolves.toBe(111);
    // delete が失敗を無視した場合でも、refresh は残った Cache API entry を読まず GitHub を再照会する
    vi.spyOn(workersCache, "delete").mockResolvedValue(undefined);
    await expect(auth.getAuthenticatedToken("12345", pkcs8PrivateKey, "org", cacheBaseUrl)).resolves.toBe(
      "new-installation-token"
    );

    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(workersCache.get(installationIdCacheKey, z.number())).resolves.toBe(222);
    await expect(auth.getInstallationId("jwt", "12345", "org", cacheBaseUrl)).resolves.toBe(222);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("新しい installation ID の token 発行も 404 なら再試行せず伝播する", async () => {
    const cacheBaseUrl = "https://stale-installation-id-single-retry.invalid";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 111, app_id: 12345 }))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ id: 222, app_id: 12345 }))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404));
    const auth = new GitHubAppAuthImpl(fetcher);

    await expect(auth.getInstallationId("jwt", "12345", "org", cacheBaseUrl)).resolves.toBe(111);
    await expect(auth.getAuthenticatedToken("12345", pkcs8PrivateKey, "org", cacheBaseUrl)).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });

    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
