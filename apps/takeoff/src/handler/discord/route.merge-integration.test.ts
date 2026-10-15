/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDiscordRoute } from "./route.js";
import { composeDiscordDependencies } from "../../composition/discord.js";
import { verifyDiscordSignature } from "../../infrastructure/discord/signature.js";
import { githubAppAuth } from "../../infrastructure/github/app-auth.js";
import { KvRegisteredRepositoryStore } from "../../repository/kv/impl.js";

import type { Env } from "../../env.js";

const discord = createDiscordRoute({
  createDependencies: composeDiscordDependencies,
  verifySignature: verifyDiscordSignature,
});

// module mock を使わず、本番の composition（usecase / cache / client の実配線）を通して /merge の成功経路を検証する
// 外部 I/O は fetch と GitHub App 認証だけを差し替える
const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const createSignedRequest = async (interaction: object): Promise<{ request: RequestInit; publicKey: string }> => {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("publicKey" in keyPair)) throw new Error("Expected a CryptoKeyPair");
  const exportedPublicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  if (!(exportedPublicKey instanceof ArrayBuffer)) throw new Error("Expected a raw public key");
  const publicKey = bytesToHex(exportedPublicKey);
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = bytesToHex(
    await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(timestamp + body))
  );

  return {
    request: {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    },
    publicKey,
  };
};

const bindings = (publicKey: string): Env["Bindings"] => ({
  ...env,
  GITHUB_APP_PRIVATE_KEY: "private-key",
  DISCORD_PUBLIC_KEY: publicKey,
  DISCORD_APPLICATION_ID: "application-id",
  MERGE_AUDIT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token",
  GITHUB_APP_ID: "github-app-id",
  GITHUB_ORG: "org",
  ALLOWED_GUILD_IDS: "guild-id",
  ADMIN_ROLE_IDS: "role-id",
  PUBLIC_BASE_URL: "https://takeoff.example.com",
});

const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const pullRequest = {
  number: 12,
  title: "fix: integration test",
  html_url: "https://github.com/org/repo/pull/12",
  state: "open",
  draft: false,
  mergeable: true,
  head: { sha: HEAD_SHA, ref: "feature/integration", label: "org:feature/integration", repo: { id: 777001 } },
  base: { ref: "main", sha: "base-sha", repo: { id: 777001 } },
  user: { login: "author" },
  updated_at: "2026-07-11T00:00:00Z",
};

describe("Discord /merge integration（実 composition 経由）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["success", "failure"])(
    "成功 followup が %s でも、その後に監査とキャッシュ更新を試行する",
    async (followupResult) => {
      vi.spyOn(githubAppAuth, "getAuthenticatedToken").mockResolvedValue("installation-token");
      const repoId = followupResult === "success" ? "777001" : "777002";
      let finishAudit: () => void = vi.fn();
      const pendingAudit = new Promise<Response>((resolve) => {
        finishAudit = () => {
          resolve(new Response(null, { status: 204 }));
        };
      });
      let finishWarming: () => void = vi.fn();
      const pendingWarming = new Promise<Response>((resolve) => {
        finishWarming = () => {
          resolve(jsonResponse([]));
        };
      });

      const requests: { method: string; url: string; body: string }[] = [];
      const dispatch = (method: string, url: string): Response => {
        if (method === "GET" && url.includes("/repos/org/repo/pulls/12")) {
          return jsonResponse({ ...pullRequest, base: { ...pullRequest.base, repo: { id: Number(repoId) } } });
        }
        if (method === "GET" && url.includes("/actions/runs?")) {
          return jsonResponse({ total_count: 0, workflow_runs: [] });
        }
        if (method === "GET" && url.includes(`/commits/${HEAD_SHA}/check-runs`)) {
          return jsonResponse({
            total_count: 1,
            check_runs: [
              {
                id: 1,
                name: "ci",
                status: "completed",
                conclusion: "success",
                html_url: null,
                app: { id: 123, slug: "github-actions" },
              },
            ],
          });
        }
        if (method === "GET" && url.includes(`/commits/${HEAD_SHA}/status`)) {
          return jsonResponse({ state: "success", total_count: 0, statuses: [] });
        }
        if (method === "GET" && url.includes("/repos/org/repo/rules/branches/main")) {
          return jsonResponse([
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "ci", integration_id: 123 }],
                strict_required_status_checks_policy: true,
              },
            },
          ]);
        }
        if (method === "PUT" && url.endsWith("/repos/org/repo/pulls/12/merge")) {
          return jsonResponse({ sha: "1234567890abcdef1234567890abcdef12345678", merged: true, message: "merged" });
        }
        if (method === "PATCH" && url.includes("/messages/@original")) {
          if (followupResult === "failure") throw new Error("Discord unavailable");
          return jsonResponse({});
        }
        throw new Error(`Unexpected fetch in integration test: ${method} ${url}`);
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
        const body = typeof init?.body === "string" ? init.body : "";
        requests.push({ method, url, body });
        if (method === "POST" && url === "https://discord.com/api/webhooks/1/token") return pendingAudit;
        if (method === "GET" && url.includes("/repos/org/repo/pulls?state=open")) return pendingWarming;
        return dispatch(method, url);
      });

      const signed = await createSignedRequest({
        type: 2,
        guild_id: "guild-id",
        data: {
          name: "merge",
          type: 1,
          options: [
            { name: "repo", type: 3, value: repoId },
            { name: "pr", type: 3, value: "12" },
          ],
        },
        token: "interaction-token",
        member: { roles: [], user: { id: "user-id", username: "tester" } },
      });

      const runtime = bindings(signed.publicKey);
      await new KvRegisteredRepositoryStore(runtime.KV).addRepository({
        repoId,
        owner: "org",
        name: "repo",
        fullName: "org/repo",
        htmlUrl: "https://github.com/org/repo",
        createdAt: "2026-07-11T00:00:00Z",
        updatedAt: "2026-07-11T00:00:00Z",
      });

      const waitUntilPromises: Promise<unknown>[] = [];
      const response = await discord.request("/interactions", signed.request, runtime, {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(promise);
        },
        passThroughOnException: vi.fn(),
        props: {},
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ type: 5, data: { flags: 64 } });

      // 監査と warming が停滞しても、成功 followup を先に試行している必要がある
      await vi.waitFor(() => {
        expect(requests.some((request) => request.method === "PATCH")).toBe(true);
        expect(requests.some((request) => request.url.includes("/pulls?state=open"))).toBe(true);
      });
      finishAudit();
      finishWarming();
      await Promise.all(waitUntilPromises);

      const mergeCall = requests.find((request) => request.method === "PUT");
      expect(mergeCall?.url).toContain("/repos/org/repo/pulls/12/merge");
      expect(JSON.parse(mergeCall?.body ?? "{}")).toMatchObject({
        sha: HEAD_SHA,
        merge_method: "squash",
        commit_title: "fix: integration test (#12)",
      });

      const auditCall = requests.find(
        (request) => request.method === "POST" && request.url === "https://discord.com/api/webhooks/1/token"
      );
      expect(auditCall).toBeDefined();

      const followupCall = requests.find(
        (request) => request.method === "PATCH" && request.url.includes("/messages/@original")
      );
      expect(followupCall).toBeDefined();
      const followupBody = JSON.parse(followupCall?.body ?? "{}") as { embeds: { title?: string }[] };
      expect(followupBody.embeds.at(0)?.title).toBe("PR をマージしました");
      if (!followupCall || !auditCall) throw new Error("Expected followup and audit requests");
      expect(requests.indexOf(followupCall)).toBeLessThan(requests.indexOf(auditCall));
      const cacheCallIndex = requests.findIndex((request) => request.url.includes("/pulls?state=open"));
      expect(requests.indexOf(followupCall)).toBeLessThan(cacheCallIndex);
    }
  );
});
