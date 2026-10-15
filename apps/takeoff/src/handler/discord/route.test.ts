import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { createDiscordRoute } from "./route.js";
import { composeDiscordDependencies } from "../../composition/discord.js";
import { verifyDiscordSignature } from "../../infrastructure/discord/signature.js";
import { KvRegisteredRepositoryStore } from "../../repository/kv/impl.js";
import { logger } from "../../util/logger.js";

import type { DiscordDependencies } from "./dependencies.js";
import type { Env } from "../../env.js";

const discord = createDiscordRoute({
  createDependencies: composeDiscordDependencies,
  verifySignature: verifyDiscordSignature,
});

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

const repoAddAutocompleteInteraction = (memberRoles: string[] | undefined): object => ({
  type: 4,
  guild_id: memberRoles === undefined ? undefined : "guild-id",
  data: {
    name: "repo",
    type: 1,
    options: [
      {
        name: "add",
        type: 1,
        options: [{ name: "full_name", type: 3, value: "org/", focused: true }],
      },
    ],
  },
  token: "interaction-token",
  member: memberRoles === undefined ? undefined : { roles: memberRoles, user: { id: "user-id" } },
});

const unsignedInteractionRequest = (interaction: object): RequestInit => ({
  method: "POST",
  headers: {
    "X-Signature-Ed25519": "signature",
    "X-Signature-Timestamp": "timestamp",
  },
  body: JSON.stringify(interaction),
});

describe("Discord interaction route", () => {
  it("正しい署名の PING へ PONG を返す", async () => {
    const signed = await createSignedRequest({ type: 1 });
    const response = await discord.request("/interactions", signed.request, bindings(signed.publicKey));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("不正な署名を 401 で拒否する", async () => {
    const response = await discord.request(
      "/interactions",
      {
        method: "POST",
        headers: {
          "X-Signature-Ed25519": "00",
          "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({ type: 1 }),
      },
      bindings("00")
    );

    expect(response.status).toBe(401);
  });

  it("大きすぎる interaction body を 413 で拒否する", async () => {
    const signed = await createSignedRequest({ type: 1, padding: "x".repeat(256 * 1024) });
    const response = await discord.request("/interactions", signed.request, bindings(signed.publicKey));

    expect(response.status).toBe(413);
  });

  it("許可されていない guild へ ephemeral error を返す", async () => {
    const signed = await createSignedRequest({
      type: 2,
      guild_id: "other-guild",
      data: { name: "repos", type: 1 },
      token: "interaction-token",
      member: { roles: [], user: { id: "user-id" } },
    });

    const response = await discord.request("/interactions", signed.request, bindings(signed.publicKey));
    const body = await response.json<{ type: number; data: { flags: number } }>();

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
  });

  it("未知の command へ ephemeral error を返す", async () => {
    const signed = await createSignedRequest({
      type: 2,
      guild_id: "guild-id",
      data: { name: "unknown", type: 1 },
      token: "interaction-token",
      member: { roles: [], user: { id: "user-id" } },
    });

    const response = await discord.request("/interactions", signed.request, bindings(signed.publicKey));
    const body = await response.json<{ type: number; data: { flags: number } }>();

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
  });

  it("dispatch 中の予期しない例外を ephemeral error へ変換する", async () => {
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    try {
      const signed = await createSignedRequest({
        type: 4,
        guild_id: "guild-id",
        data: { name: "merge", type: 1 },
        token: "interaction-token",
        member: { roles: [], user: { id: "user-id" } },
      });

      const response = await discord.request("/interactions", signed.request, bindings(signed.publicKey));
      const body = await response.json<{ type: number; data: { embeds: { title?: string }[]; flags: number } }>();

      expect(response.status).toBe(200);
      expect(body.type).toBe(4);
      expect(body.data.flags).toBe(64);
      expect(body.data.embeds[0]?.title).toBe("内部エラーが発生しました");
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each([
    ["admin role を持たない member", repoAddAutocompleteInteraction([])],
    ["DM", repoAddAutocompleteInteraction(undefined)],
  ])("%s の /repo add autocomplete は依存を作らず空 choices を返す", async (_caseName, interaction) => {
    const createDependencies = vi.fn(() => {
      throw new Error("dependencies must not be created");
    });
    const guardedDiscord = createDiscordRoute({
      createDependencies,
      verifySignature: vi.fn().mockResolvedValue(true),
    });

    const response = await guardedDiscord.request(
      "/interactions",
      unsignedInteractionRequest(interaction),
      bindings("public-key")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 8, data: { choices: [] } });
    expect(createDependencies).not.toHaveBeenCalled();
  });

  it("admin role を持つ member だけが /repo add autocomplete の候補を取得する", async () => {
    const getCachedInstallationRepositories = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          owner: "org",
          name: "private-repo",
          fullName: "org/private-repo",
          htmlUrl: "https://github.com/org/private-repo",
        },
      ],
      fetchedAt: "2026-08-11T00:00:00.000Z",
    });
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories,
        getCachedRepositoryIndex: vi.fn().mockResolvedValue({
          items: [],
          updatedAt: "2026-08-11T00:00:00.000Z",
        }),
      },
    } as unknown as DiscordDependencies;
    const createDependencies = vi.fn(() => deps);
    const guardedDiscord = createDiscordRoute({
      createDependencies,
      verifySignature: vi.fn().mockResolvedValue(true),
    });

    const response = await guardedDiscord.request(
      "/interactions",
      unsignedInteractionRequest(repoAddAutocompleteInteraction(["role-id"])),
      bindings("public-key")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      type: 8,
      data: { choices: [{ name: "org/private-repo", value: "private-repo" }] },
    });
    expect(createDependencies).toHaveBeenCalledOnce();
    expect(getCachedInstallationRepositories).toHaveBeenCalledOnce();
  });

  it("repository 削除 button で role を再検証して削除する", async () => {
    const testBindings = bindings((await createSignedRequest({ type: 1 })).publicKey);
    const repoStore = new KvRegisteredRepositoryStore(testBindings.KV);
    await repoStore.addRepository({
      repoId: "component-remove-repo",
      owner: "org",
      name: "component-remove-repo",
      fullName: "org/component-remove-repo",
      htmlUrl: "https://github.com/org/component-remove-repo",
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
    });
    const signed = await createSignedRequest({
      type: 3,
      guild_id: "guild-id",
      data: { component_type: 2, custom_id: "repo.remove.confirm:component-remove-repo" },
      token: "interaction-token",
      member: { roles: ["role-id"], user: { id: "user-id" } },
    });

    const followupRequests: { url: string; body: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      followupRequests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return Promise.resolve(new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } }));
    });

    const waitUntilPromises: Promise<unknown>[] = [];
    const response = await discord.request(
      "/interactions",
      signed.request,
      {
        ...testBindings,
        DISCORD_PUBLIC_KEY: signed.publicKey,
      },
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(promise);
        },
        passThroughOnException: vi.fn(),
        props: {},
      }
    );
    const body = await response.json<{ type: number }>();

    expect(response.status).toBe(200);
    // 3 秒の制限時間内に応答するため、KV 操作前に deferred update で確定する
    expect(body.type).toBe(6);

    await Promise.all(waitUntilPromises);

    const followup = followupRequests.find((request) => request.url.includes("/messages/@original"));
    const followupBody = JSON.parse(followup?.body ?? "{}") as { embeds: { title?: string }[] };
    expect(followupBody.embeds[0]?.title).toBe("リポジトリの登録を解除しました");
    await expect(repoStore.getRepository("component-remove-repo")).resolves.toBeNull();
    vi.restoreAllMocks();
  });
});
