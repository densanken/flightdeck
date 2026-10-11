import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitHubWebhookRoute } from "./webhook.js";
import { composeGitHubWebhookDependencies } from "../../composition/github.js";
import { composeDependencyGraph } from "../../composition/shared.js";
import { githubAppAuth } from "../../infrastructure/github/app-auth.js";
import { verifyGitHubWebhookSignature } from "../../infrastructure/github/webhook-signature.js";

import type { GitHubWebhookRouteDependencies } from "./webhook.js";
import type { Env } from "../../env.js";
import type { RegisteredRepositorySnapshot } from "../../repository/kv/interface.js";
import type { AutoApproveUsecase } from "../../usecase/auto-approve/interface.js";

vi.mock("../../infrastructure/github/webhook-signature.js", () => ({
  verifyGitHubWebhookSignature: vi.fn(),
}));

const mockedVerify = vi.mocked(verifyGitHubWebhookSignature);
const mockedAutoApprove = vi.fn<AutoApproveUsecase["autoApproveByRunId"]>();
const mockAutoApproveUsecase: AutoApproveUsecase = {
  autoApproveByRunId: mockedAutoApprove,
  approveActionRequiredRuns: vi.fn(),
};

type KvGetMock = ReturnType<typeof vi.fn<(key: string | string[]) => Promise<unknown>>>;
type KvPutMock = ReturnType<typeof vi.fn<(key: string, value: string) => Promise<void>>>;
type KvDeleteMock = ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
type KvListMock = ReturnType<
  typeof vi.fn<() => Promise<{ keys: { name: string; metadata: unknown }[]; list_complete: true }>>
>;

interface MockKv {
  get: KvGetMock;
  put: KvPutMock;
  delete: KvDeleteMock;
  list: KvListMock;
}

const kvGetMock = (runtime: Env["Bindings"]): KvGetMock => (runtime.KV as unknown as MockKv).get;
const kvPutMock = (runtime: Env["Bindings"]): KvPutMock => (runtime.KV as unknown as MockKv).put;
const kvDeleteMock = (runtime: Env["Bindings"]): KvDeleteMock => (runtime.KV as unknown as MockKv).delete;

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const createApp = (overrides: Partial<GitHubWebhookRouteDependencies> = {}): Hono<Env> => {
  const route = createGitHubWebhookRoute({
    createDependencies: (env) => ({
      ...composeGitHubWebhookDependencies(env),
      autoApproveUsecase: mockAutoApproveUsecase,
    }),
    verifySignature: verifyGitHubWebhookSignature,
    ...overrides,
  });
  const instance = new Hono<Env>();
  instance.route("/webhooks", route);
  return instance;
};

const app = createApp();

// auto-approve も composition で配線した usecase を使う route
const composedApp = createApp({ createDependencies: composeGitHubWebhookDependencies });

const createMockEnv = (): Env["Bindings"] =>
  ({
    GITHUB_WEBHOOK_SECRET: "test-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "key",
    GITHUB_ORG: "my-org",
    MERGE_AUDIT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token",
    PUBLIC_BASE_URL: "https://example.com",
    KV: {
      get: vi.fn<(key: string | string[]) => Promise<unknown>>(),
      put: vi.fn<(key: string, value: string) => Promise<void>>().mockResolvedValue(undefined),
      delete: vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
      list: vi.fn<KvListMock>().mockResolvedValue({
        keys: [],
        list_complete: true,
      }),
    },
  }) as unknown as Env["Bindings"];

const seedRegisteredRepository = (runtime: Env["Bindings"], repository: RegisteredRepositorySnapshot) => {
  const key = `repo:${repository.repoId}`;
  const values = new Map<string, unknown>([[key, repository]]);
  kvGetMock(runtime).mockImplementation((requestedKey) =>
    Promise.resolve(
      Array.isArray(requestedKey)
        ? new Map(requestedKey.map((item) => [item, values.get(item) ?? null]))
        : (values.get(requestedKey) ?? null)
    )
  );
  kvPutMock(runtime).mockImplementation((requestedKey, value) => {
    values.set(requestedKey, JSON.parse(value) as unknown);
    return Promise.resolve();
  });
  const kv = runtime.KV as unknown as MockKv;
  kv.list.mockResolvedValue({ keys: [{ name: key, metadata: repository }], list_complete: true });
  return values;
};

const forkPrPayload = (overrides?: {
  action?: string;
  event?: string;
  headRepoFullName?: string;
  repoName?: string;
  repoFullName?: string;
}) => ({
  action: overrides?.action ?? "requested",
  workflow_run: {
    id: 100,
    name: "CI",
    status: "queued",
    event: overrides?.event ?? "pull_request",
    actor: { login: "contributor" },
    head_repository: {
      full_name: overrides?.headRepoFullName ?? "contributor/repo",
    },
  },
  repository: {
    id: 1,
    name: overrides?.repoName ?? "repo",
    full_name: overrides?.repoFullName ?? "owner/repo",
    owner: { login: "owner" },
  },
});

const postWebhook = (
  env: Env["Bindings"],
  body: string,
  headers?: Record<string, string | undefined>,
  targetApp: Hono<Env> = app
) => {
  const waitUntilPromises: Promise<unknown>[] = [];
  const requestHeaders = new Headers({
    "Content-Type": "application/json",
    "X-Hub-Signature-256": "sha256=valid",
    "X-GitHub-Event": "workflow_run",
    "X-GitHub-Delivery": "delivery-1",
  });
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) {
      requestHeaders.delete(name);
    } else {
      requestHeaders.set(name, value);
    }
  }
  return {
    response: targetApp.request(
      "/webhooks/github",
      {
        method: "POST",
        headers: requestHeaders,
        body,
      },
      env,
      {
        waitUntil: (p: Promise<unknown>) => {
          waitUntilPromises.push(p);
        },
        passThroughOnException: vi.fn(),
        props: {},
      }
    ),
    waitUntilSettled: () => Promise.all(waitUntilPromises),
  };
};

describe("GitHub webhook handler", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("署名不正で 401 を返す", async () => {
    mockedVerify.mockResolvedValue(false);
    const env = createMockEnv();

    const { response } = postWebhook(env, JSON.stringify(forkPrPayload()));
    const res = await response;

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid signature" });
    expect(mockedVerify).toHaveBeenCalledWith("test-secret", "sha256=valid", expect.any(Uint8Array));
  });

  it("署名検証前に Content-Type と body 上限を検査する", async () => {
    const env = createMockEnv();
    const wrongContentType = postWebhook(env, "{}", { "Content-Type": "text/plain" });
    const wrongContentTypeResponse = await wrongContentType.response;

    expect(wrongContentTypeResponse.status).toBe(415);
    expect(mockedVerify).not.toHaveBeenCalled();

    const tooLarge = postWebhook(env, "x".repeat(256 * 1024 + 1));
    const tooLargeResponse = await tooLarge.response;

    expect(tooLargeResponse.status).toBe(413);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("有効な署名で不正 JSON body のとき 400 を返す", async () => {
    mockedVerify.mockResolvedValue(true);
    const env = createMockEnv();

    const { response } = postWebhook(env, "{not valid json");
    const res = await response;

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid body" });
    expect(mockedAutoApprove).not.toHaveBeenCalled();
  });

  it("workflow_run の schema 不一致は 200 で受理し payload を混入させず autoApprove も呼ばない", async () => {
    mockedVerify.mockResolvedValue(true);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    const env = createMockEnv();
    const sentinel = "LEAK_SENTINEL_9f3a";

    const { response } = postWebhook(env, JSON.stringify({ not: "a workflow_run event", leak: sentinel }));
    const res = await response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    const invalidCalls = consoleErrorSpy.mock.calls.filter((call) => call[0] === "github_webhook_payload_invalid");
    expect(invalidCalls).toHaveLength(1);
    const detail = invalidCalls[0]?.[1] as { event: string; issueCount: number };
    expect(detail.event).toBe("workflow_run");
    expect(detail.issueCount).toBeGreaterThan(0);
    expect(mockedAutoApprove).not.toHaveBeenCalled();
    // ZodError（payload 由来の値）はログへ乗せない
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(sentinel);
  });

  it("repository の schema 不一致は 200 で受理し KV を書かず payload も混入させない", async () => {
    mockedVerify.mockResolvedValue(true);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    const env = createMockEnv();
    const sentinel = "LEAK_SENTINEL_repo";

    const { response } = postWebhook(env, JSON.stringify({ action: "renamed", repository: { id: sentinel } }), {
      "X-GitHub-Event": "repository",
    });
    const res = await response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    const invalidCalls = consoleErrorSpy.mock.calls.filter((call) => call[0] === "github_webhook_payload_invalid");
    expect(invalidCalls).toHaveLength(1);
    const detail = invalidCalls[0]?.[1] as { event: string; issueCount: number };
    expect(detail.event).toBe("repository");
    expect(detail.issueCount).toBeGreaterThan(0);
    expect(kvPutMock(env)).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(sentinel);
  });

  it("X-GitHub-Event が workflow_run 以外で 200 を返す", async () => {
    mockedVerify.mockResolvedValue(true);
    const env = createMockEnv();

    const { response } = postWebhook(env, JSON.stringify(forkPrPayload()), {
      "X-GitHub-Event": "push",
    });
    const res = await response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("action が requested 以外で 200 を返す", async () => {
    mockedVerify.mockResolvedValue(true);
    const env = createMockEnv();

    const { response } = postWebhook(env, JSON.stringify(forkPrPayload({ action: "completed" })));
    const res = await response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(mockedAutoApprove).not.toHaveBeenCalled();
  });

  it("fork PR でないとき 200 を返す", async () => {
    mockedVerify.mockResolvedValue(true);
    const env = createMockEnv();

    const { response } = postWebhook(
      env,
      JSON.stringify(
        forkPrPayload({
          headRepoFullName: "owner/repo",
          repoFullName: "owner/repo",
        })
      )
    );
    const res = await response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(mockedAutoApprove).not.toHaveBeenCalled();
  });

  it("event の処理を待たずに 200 を返し、処理は waitUntil へ回す", async () => {
    mockedVerify.mockResolvedValue(true);
    mockedAutoApprove.mockReturnValue(new Promise(() => undefined));
    const env = createMockEnv();

    const { response } = postWebhook(env, JSON.stringify(forkPrPayload()));
    const res = await response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(mockedAutoApprove).toHaveBeenCalledOnce();
  });

  it("未登録 repository なら token も GitHub API も使わない", async () => {
    mockedVerify.mockResolvedValue(true);
    const getTokenSpy = vi.spyOn(githubAppAuth, "getAuthenticatedToken");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = createMockEnv();
    kvGetMock(env).mockResolvedValue(null);

    const { response, waitUntilSettled } = postWebhook(env, JSON.stringify(forkPrPayload()), undefined, composedApp);
    const res = await response;
    await waitUntilSettled();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(getTokenSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("org メンバーの fork PR で承認が実行される", async () => {
    mockedVerify.mockResolvedValue(true);
    mockedAutoApprove.mockResolvedValue({
      type: "evaluated",
      approved: true,
      reason: "Approved run 100 by contributor",
    });
    const env = createMockEnv();

    const { response, waitUntilSettled } = postWebhook(
      env,
      JSON.stringify(forkPrPayload({ repoName: "renamed-repo", repoFullName: "owner/renamed-repo" }))
    );
    const res = await response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });

    await waitUntilSettled();

    // KV の登録情報（旧名 repo）ではなく payload の最新座標で API を呼ぶ
    expect(mockedAutoApprove).toHaveBeenCalledWith({
      repoId: "1",
      owner: "owner",
      repo: "renamed-repo",
      runId: 100,
      actorLogin: "contributor",
    });
  });

  it("auto-approve の例外から credential を記録しない", async () => {
    const secret = "github_pat_secret";
    mockedVerify.mockResolvedValue(true);
    mockedAutoApprove.mockRejectedValue(new Error(secret));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    const env = createMockEnv();

    const { response, waitUntilSettled } = postWebhook(env, JSON.stringify(forkPrPayload()));

    expect((await response).status).toBe(200);
    await waitUntilSettled();
    expect(consoleErrorSpy).toHaveBeenCalledWith("github_webhook_auto_approve_failed", {
      repositoryId: "1",
      runId: 100,
      errorName: "Error",
    });
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(secret);
  });

  it("repository renamed は payload 座標でなく repository ID の GitHub 最新 C へ収束する", async () => {
    mockedVerify.mockResolvedValue(true);
    vi.spyOn(githubAppAuth, "getAuthenticatedToken").mockResolvedValue("installation-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          id: 1,
          name: "current-c",
          full_name: "my-org/current-c",
          html_url: "https://github.com/my-org/current-c",
          owner: { login: "my-org" },
        })
      )
    );
    const env = createMockEnv();
    const registered = {
      repoId: "1",
      registrationId: "registration-1",
      fullName: "my-org/old-a",
      owner: "my-org",
      name: "old-name",
      htmlUrl: "https://github.com/my-org/old-a",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    const values = seedRegisteredRepository(env, registered);

    const { response, waitUntilSettled } = postWebhook(
      env,
      JSON.stringify({
        action: "renamed",
        repository: {
          id: 1,
          name: "stale-b",
          full_name: "my-org/stale-b",
          html_url: "https://github.com/my-org/stale-b",
          owner: { login: "my-org" },
        },
      }),
      { "X-GitHub-Event": "repository", "X-GitHub-Delivery": "rename-delivery-1" }
    );
    const res = await response;
    await waitUntilSettled();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });

    expect(fetchSpy.mock.calls.at(0)?.[0]).toBe("https://api.github.com/repositories/1");
    expect(new Headers(fetchSpy.mock.calls.at(0)?.[1]?.headers).get("Authorization")).toBe("token installation-token");
    const putKeys = kvPutMock(env).mock.calls.map(([key]) => key);
    expect(putKeys).toEqual([`repo-metadata:1:${registered.registrationId}`]);
    expect(values.get("repo:1")).toEqual(registered);
    const { repoStore } = composeDependencyGraph(env);
    await expect(repoStore.getRepository("1")).resolves.toMatchObject({ fullName: "my-org/current-c" });
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({
      items: [{ repoId: "1", fullName: "my-org/current-c" }],
    });
  });

  it("同 delivery replay・逆順・旧 payload の後も GitHub 最新 C へ収束する", async () => {
    mockedVerify.mockResolvedValue(true);
    vi.spyOn(githubAppAuth, "getAuthenticatedToken").mockResolvedValue("installation-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          id: 1,
          name: "current-c",
          full_name: "my-org/current-c",
          html_url: "https://github.com/my-org/current-c",
          owner: { login: "my-org" },
        })
      )
    );
    const env = createMockEnv();
    const registered = {
      repoId: "1",
      registrationId: "registration-1",
      owner: "my-org",
      name: "old-a",
      fullName: "my-org/old-a",
      htmlUrl: "https://github.com/my-org/old-a",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    const values = seedRegisteredRepository(env, registered);

    const payload = (name: string) =>
      JSON.stringify({
        action: "renamed",
        repository: {
          id: 1,
          name,
          full_name: `my-org/${name}`,
          html_url: `https://github.com/my-org/${name}`,
          owner: { login: "my-org" },
        },
      });

    const first = postWebhook(env, payload("stale-b"), {
      "X-GitHub-Event": "repository",
      "X-GitHub-Delivery": "same-delivery",
    });
    expect((await first.response).status).toBe(200);
    await first.waitUntilSettled();
    const replay = postWebhook(env, payload("stale-b"), {
      "X-GitHub-Event": "repository",
      "X-GitHub-Delivery": "same-delivery",
    });
    expect((await replay.response).status).toBe(200);
    await replay.waitUntilSettled();
    const reversed = postWebhook(env, payload("older-a"), {
      "X-GitHub-Event": "repository",
      "X-GitHub-Delivery": "older-delivery",
    });
    expect((await reversed.response).status).toBe(200);
    await reversed.waitUntilSettled();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const repositoryWrites = kvPutMock(env).mock.calls.filter(
      ([key]) => key === `repo-metadata:1:${registered.registrationId}`
    );
    expect(repositoryWrites).toHaveLength(3);
    for (const [, body] of repositoryWrites) {
      expect(JSON.parse(body)).toMatchObject({ fullName: "my-org/current-c" });
    }
    expect(kvPutMock(env).mock.calls.some(([key]) => key === "repo:1")).toBe(false);
    expect(values.get("repo:1")).toEqual(registered);
    const { repoStore } = composeDependencyGraph(env);
    await expect(repoStore.getRepository("1")).resolves.toMatchObject({ fullName: "my-org/current-c" });
    await expect(repoStore.getRepositoryIndex()).resolves.toMatchObject({
      items: [{ repoId: "1", fullName: "my-org/current-c" }],
    });
  });

  it("org 外へ transfer 済みなら登録解除する", async () => {
    mockedVerify.mockResolvedValue(true);
    vi.spyOn(githubAppAuth, "getAuthenticatedToken").mockResolvedValue("installation-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: 1,
        name: "repo",
        full_name: "outside/repo",
        html_url: "https://github.com/outside/repo",
        owner: { login: "outside" },
      })
    );
    const env = createMockEnv();
    kvGetMock(env).mockResolvedValue({
      repoId: "1",
      registrationId: "registration-1",
      owner: "my-org",
      name: "repo",
      fullName: "my-org/repo",
      htmlUrl: "https://github.com/my-org/repo",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    const { response, waitUntilSettled } = postWebhook(
      env,
      JSON.stringify({
        action: "transferred",
        repository: {
          id: 1,
          name: "stale-name",
          full_name: "my-org/stale-name",
          html_url: "https://github.com/my-org/stale-name",
          owner: { login: "my-org" },
        },
      }),
      { "X-GitHub-Event": "repository" }
    );
    const res = await response;
    await waitUntilSettled();

    expect(res.status).toBe(200);
    expect(kvDeleteMock(env)).toHaveBeenCalledWith("repo:1");
  });

  it("installation から確実に消えた 404 なら登録解除する", async () => {
    mockedVerify.mockResolvedValue(true);
    vi.spyOn(githubAppAuth, "getAuthenticatedToken").mockResolvedValue("installation-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const env = createMockEnv();
    kvGetMock(env).mockResolvedValue({
      repoId: "1",
      registrationId: "registration-1",
      owner: "my-org",
      name: "repo",
      fullName: "my-org/repo",
      htmlUrl: "https://github.com/my-org/repo",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    const { response, waitUntilSettled } = postWebhook(
      env,
      JSON.stringify({
        action: "renamed",
        repository: {
          id: 1,
          name: "stale-name",
          full_name: "my-org/stale-name",
          html_url: "https://github.com/my-org/stale-name",
          owner: { login: "my-org" },
        },
      }),
      { "X-GitHub-Event": "repository" }
    );

    expect((await response).status).toBe(200);
    await waitUntilSettled();
    expect(kvDeleteMock(env)).toHaveBeenCalledWith("repo:1");
  });

  it.each([
    ["transient failure", jsonResponse({ message: "Unavailable" }, 503)],
    ["shape failure", jsonResponse({ id: 1, name: "partial" })],
  ])("GitHub %s は記録だけ残し、登録を変更しない", async (_caseName, githubResponse) => {
    mockedVerify.mockResolvedValue(true);
    vi.spyOn(githubAppAuth, "getAuthenticatedToken").mockResolvedValue("installation-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(githubResponse);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    const env = createMockEnv();
    kvGetMock(env).mockResolvedValue({
      repoId: "1",
      registrationId: "registration-1",
      owner: "my-org",
      name: "old-name",
      fullName: "my-org/old-name",
      htmlUrl: "https://github.com/my-org/old-name",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    const { response, waitUntilSettled } = postWebhook(
      env,
      JSON.stringify({
        action: "renamed",
        repository: {
          id: 1,
          name: "payload-name",
          full_name: "my-org/payload-name",
          html_url: "https://github.com/my-org/payload-name",
          owner: { login: "my-org" },
        },
      }),
      { "X-GitHub-Event": "repository" }
    );

    expect((await response).status).toBe(200);
    await waitUntilSettled();
    expect(consoleErrorSpy).toHaveBeenCalledWith("github_repository_reconcile_failed", {
      deliveryId: "delivery-1",
      repositoryId: "1",
      errorName: "GitHubError",
    });
    expect(kvPutMock(env)).not.toHaveBeenCalled();
    expect(kvDeleteMock(env)).not.toHaveBeenCalled();
  });

  it("未登録 repository の renamed イベントは GitHub API も cache も触らない", async () => {
    mockedVerify.mockResolvedValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = createMockEnv();
    kvGetMock(env).mockResolvedValue(null);

    const { response, waitUntilSettled } = postWebhook(
      env,
      JSON.stringify({
        action: "renamed",
        repository: {
          id: 999,
          name: "new-name",
          full_name: "my-org/new-name",
          html_url: "https://github.com/my-org/new-name",
          owner: { login: "my-org" },
        },
      }),
      { "X-GitHub-Event": "repository" }
    );

    expect((await response).status).toBe(200);
    await waitUntilSettled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kvPutMock(env)).not.toHaveBeenCalled();
    expect(kvDeleteMock(env)).not.toHaveBeenCalled();
  });

  it("KV の登録値が壊れているときは auto-approve の失敗として記録する", async () => {
    mockedVerify.mockResolvedValue(true);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    const env = createMockEnv();
    kvGetMock(env).mockResolvedValue({ repoId: "1", broken: true });

    const { response, waitUntilSettled } = postWebhook(env, JSON.stringify(forkPrPayload()), undefined, composedApp);

    expect((await response).status).toBe(200);
    await waitUntilSettled();
    expect(consoleErrorSpy).toHaveBeenCalledWith("github_webhook_auto_approve_failed", {
      repositoryId: "1",
      runId: 100,
      errorName: "Error",
    });
  });

  it("署名検証が例外を投げたら固定の 500 を返し、delivery ID と段階を記録する", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    mockedVerify.mockRejectedValue(new TypeError("verifier broken"));
    const env = createMockEnv();

    const { response } = postWebhook(env, JSON.stringify(forkPrPayload()));
    const res = await response;

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal error" });
    expect(consoleErrorSpy).toHaveBeenCalledWith("github_webhook_receive_failed", {
      deliveryId: "delivery-1",
      stage: "signature_verification",
      errorName: "TypeError",
    });
  });

  it("body の読み取りが例外を投げたら固定の 500 を返し、delivery ID と段階を記録する", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    vi.spyOn(Request.prototype, "arrayBuffer").mockRejectedValue(new TypeError("stream broken"));
    const env = createMockEnv();

    const { response } = postWebhook(env, JSON.stringify(forkPrPayload()));
    const res = await response;

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal error" });
    expect(consoleErrorSpy).toHaveBeenCalledWith("github_webhook_receive_failed", {
      deliveryId: "delivery-1",
      stage: "body_read",
      errorName: "TypeError",
    });
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("X-GitHub-Delivery がなければ 400 で拒否する", async () => {
    const env = createMockEnv();
    const { response } = postWebhook(env, JSON.stringify(forkPrPayload()), {
      "X-GitHub-Delivery": undefined,
    });

    expect((await response).status).toBe(400);
  });
});
