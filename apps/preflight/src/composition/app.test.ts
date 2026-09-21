import { beforeAll, describe, expect, it, vi } from "vitest";

import { composeApp, composeGitHubWebhookProcessor } from "./app.js";
import { parsePullRequestWebhookPayload } from "../handler/github/payload.js";
import { MemoryCacheStorage, RecordingLogger } from "../test-helper/platform.js";
import { createTestPrivateKey, pullRequestBody, TEST_WEBHOOK_SECRET, webhookRequest } from "../test-helper/webhook.js";

import type { Env } from "../env.js";
import type { PullRequestWebhookPayload } from "../handler/github/payload.js";

const jsonResponse = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const requestBody = (init: RequestInit | undefined): string => {
  if (typeof init?.body !== "string") throw new Error("Expected a string request body");
  return init.body;
};

// consumer は Queue message の body から payload を復元してから処理する
const webhookPayload = (body: string): PullRequestWebhookPayload => {
  const payload = parsePullRequestWebhookPayload(JSON.parse(body) as unknown);
  if (!payload) throw new Error("Expected a valid pull_request payload");
  return payload;
};

const postedStatuses = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): { sha: string; state: string }[] =>
  fetchImpl.mock.calls
    .filter(([input, init]) => new URL(requestUrl(input)).pathname.includes("/statuses/") && init?.method === "POST")
    .map(([input, init]) => ({
      sha: new URL(requestUrl(input)).pathname.split("/").at(-1) ?? "",
      state: (JSON.parse(requestBody(init)) as { state: string }).state,
    }));

let privateKeyPem = "";

const env = (): Env => ({
  GITHUB_APP_ID: "12345",
  GITHUB_PRIVATE_KEY: privateKeyPem,
  GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  GITHUB_APP_BOT_USER_ID: "4242",
  DELIVERY_CACHE_TTL_SECONDS: "86400",
  SKIP_BOTS: "true",
  LOG_LEVEL: "debug",
});

// sweep が投げる PullRequestTitleStatuses query の response
// 掃除対象 stale-sha を 1 件含めることで、query -> parse -> status POST を e2e で通す
const commitTitleStatusesResponse = (headSha = "abc123") => ({
  data: {
    repository: {
      pullRequest: {
        commits: {
          nodes: [
            {
              commit: {
                oid: "stale-sha",
                status: { context: { state: "FAILURE" } },
                associatedPullRequests: { totalCount: 1, nodes: [{ state: "OPEN", headRefOid: headSha }] },
              },
            },
            {
              commit: {
                oid: headSha,
                status: { context: { state: "SUCCESS" } },
                associatedPullRequests: { totalCount: 1, nodes: [{ state: "OPEN", headRefOid: headSha }] },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
});

const successfulGitHubFetch = (options: { assigneesStatus?: number } = {}) => {
  return vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = requestUrl(input);
    if (url.endsWith("/access_tokens")) {
      return Promise.resolve(jsonResponse({ token: "installation-token", expires_at: "2026-07-16T01:00:00Z" }, 201));
    }
    if (url.endsWith("/assignees")) {
      if (options.assigneesStatus !== undefined) {
        return Promise.resolve(jsonResponse({ message: "assignees failed" }, options.assigneesStatus));
      }
      return Promise.resolve(jsonResponse({ assignees: [{ login: "author" }] }, 201));
    }
    if (new URL(url).pathname.endsWith("/pulls/7")) {
      return Promise.resolve(
        jsonResponse({ title: "feat: add login", state: "open", head: { sha: "abc123" }, draft: false }, 200)
      );
    }
    if (new URL(url).pathname.endsWith("/commits/abc123/pulls")) {
      return Promise.resolve(
        jsonResponse(
          [{ number: 7, title: "feat: add login", state: "open", head: { sha: "abc123" }, draft: false }],
          200
        )
      );
    }
    if (new URL(url).pathname === "/graphql") {
      if (requestBody(init).includes("PullRequestTitleStatuses")) {
        return Promise.resolve(jsonResponse(commitTitleStatusesResponse(), 200));
      }
      return Promise.resolve(
        jsonResponse(
          {
            data: {
              repository: {
                pullRequests: {
                  totalCount: 1,
                  nodes: [{ number: 7, title: "feat: add login", state: "OPEN", headRefOid: "abc123", isDraft: false }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
          200
        )
      );
    }
    if (new URL(url).pathname === "/app") {
      return Promise.resolve(jsonResponse({ slug: "preflight" }, 200));
    }
    if (new URL(url).pathname.startsWith("/users/")) {
      return Promise.resolve(jsonResponse({ id: 4242 }, 200));
    }
    if (new URL(url).pathname.startsWith("/repos/owner/repo/statuses/") && init?.method === "POST") {
      return Promise.resolve(jsonResponse({}, 201));
    }
    if (url.includes("/comments") && init?.method === "GET") return Promise.resolve(jsonResponse([], 200));
    return Promise.reject(new Error(`Unexpected GitHub request: ${String(init?.method)} ${url}`));
  });
};

describe("composeApp", () => {
  beforeAll(async () => {
    privateKeyPem = await createTestPrivateKey();
  });

  it("pending から usecase, GitHub gateway, delivery cache までを結線し、同じ delivery の 2 回目を duplicate にする", async () => {
    const fetchImpl = successfulGitHubFetch();
    const cacheStorage = new MemoryCacheStorage();
    const hardDeadlineController = new AbortController();
    const createHardDeadlineSignal = vi.fn(() => hardDeadlineController.signal);
    const bindings = env();
    const processor = composeGitHubWebhookProcessor(bindings, {
      fetchImpl,
      cacheStorage,
      appBotIdentityCache: new Map(),
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      createHardDeadlineSignal,
    });
    const body = pullRequestBody();

    const first = await processor(webhookPayload(body), { deliveryId: "delivery-1", attempt: 1 });
    expect(first).toEqual({ status: "processed", result: "assigned" });
    expect(createHardDeadlineSignal).toHaveBeenCalledOnce();
    const accessTokenSignal = fetchImpl.mock.calls.find(([input]) => requestUrl(input).endsWith("/access_tokens"))?.[1]
      ?.signal;
    expect(accessTokenSignal).toBe(hardDeadlineController.signal);

    const duplicate = await processor(webhookPayload(body), { deliveryId: "delivery-1", attempt: 1 });

    expect(duplicate).toEqual({ status: "processed", result: "duplicate" });
    expect(createHardDeadlineSignal).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(16);
    // 検証を始める前に pending を投稿し、処理済みと判定した再配信では投稿しない
    expect(postedStatuses(fetchImpl).at(0)).toEqual({ sha: "abc123", state: "pending" });
    expect(postedStatuses(fetchImpl).filter((write) => write.state === "pending")).toHaveLength(1);
    // pending と検証本体で installation access token を共有する
    expect(fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/access_tokens"))).toHaveLength(1);
    const signals = fetchImpl.mock.calls.map(([, init]) => init?.signal);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    hardDeadlineController.abort();
    for (const signal of signals) expect(signal?.aborted).toBe(true);
    expect(cacheStorage.cache.entries.size).toBe(2);
  });

  it("cache が空の別 colo へ再配信されたときは pending を書き直し、同じ実行で最終 status まで書く", async () => {
    // consumer が別 colo で動くと delivery cache も isolate の identity cache も空になる
    // pending を書いたら必ず同じ実行で verdict まで書く
    const bindings = env();
    const first = successfulGitHubFetch();
    const second = successfulGitHubFetch();
    const delivery = { deliveryId: "delivery-redelivered", attempt: 1 };
    const body = pullRequestBody();

    const firstOutcome = await composeGitHubWebhookProcessor(bindings, {
      fetchImpl: first,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
    })(webhookPayload(body), delivery);
    const redeliveredOutcome = await composeGitHubWebhookProcessor(bindings, {
      fetchImpl: second,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
    })(webhookPayload(body), delivery);

    expect(firstOutcome).toEqual({ status: "processed", result: "assigned" });
    expect(redeliveredOutcome).toEqual({ status: "processed", result: "assigned" });
    for (const writes of [postedStatuses(first), postedStatuses(second)]) {
      expect(writes.at(0)).toEqual({ sha: "abc123", state: "pending" });
      expect(writes.filter((write) => write.sha === "abc123").at(-1)).toEqual({ sha: "abc123", state: "success" });
      expect(writes.at(-1)?.state).not.toBe("pending");
    }
    // 別 colo では isolate ごとの identity cache も空なので、token も Bot identity も取り直す
    for (const fetchImpl of [first, second]) {
      expect(fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/access_tokens"))).toHaveLength(1);
      expect(fetchImpl.mock.calls.filter(([input]) => new URL(requestUrl(input)).pathname === "/app")).toHaveLength(1);
      expect(
        fetchImpl.mock.calls.filter(([input]) => new URL(requestUrl(input)).pathname.startsWith("/users/"))
      ).toHaveLength(1);
    }
  });

  it("auto-assign だけが失敗した delivery を Queue が retry したとき、確定した status を pending へ戻さない", async () => {
    // attempt 1 は auto-assign が失敗して retry になるが、title validation は success まで書き終えている
    // retry は別 colo になり得て delivery cache も空なので、そこで pending を書くと確定した success が pending へ戻る
    const bindings = env();
    const body = pullRequestBody();
    const firstAttempt = successfulGitHubFetch({ assigneesStatus: 500 });
    const secondAttempt = successfulGitHubFetch({ assigneesStatus: 500 });

    const firstOutcome = await composeGitHubWebhookProcessor(bindings, {
      fetchImpl: firstAttempt,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
    })(webhookPayload(body), { deliveryId: "delivery-retried", attempt: 1 });
    const retryOutcome = await composeGitHubWebhookProcessor(bindings, {
      fetchImpl: secondAttempt,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
    })(webhookPayload(body), { deliveryId: "delivery-retried", attempt: 2 });

    expect(firstOutcome.status).toBe("failed");
    expect(retryOutcome.status).toBe("failed");
    expect(
      postedStatuses(firstAttempt)
        .filter((write) => write.sha === "abc123")
        .map((write) => write.state)
    ).toEqual(["pending", "success"]);
    expect(postedStatuses(secondAttempt).filter((write) => write.state === "pending")).toHaveLength(0);
    expect(
      postedStatuses(secondAttempt)
        .filter((write) => write.sha === "abc123")
        .map((write) => write.state)
    ).toEqual(["success"]);
  });

  it("title 検証が失敗しても最後に書く status は pending ではなく error にする", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/access_tokens")) {
        return Promise.resolve(jsonResponse({ token: "installation-token", expires_at: "2026-07-16T01:00:00Z" }, 201));
      }
      if (url.endsWith("/assignees")) return Promise.resolve(jsonResponse({ assignees: [{ login: "author" }] }, 201));
      if (new URL(url).pathname.startsWith("/repos/owner/repo/statuses/") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({}, 201));
      }
      // 状態取得だけを落とし、fail-closed の error status を書かせる
      if (new URL(url).pathname.endsWith("/pulls/7")) return Promise.resolve(jsonResponse({}, 500));
      return Promise.reject(new Error(`Unexpected GitHub request: ${String(init?.method)} ${url}`));
    });

    const outcome = await composeGitHubWebhookProcessor(env(), {
      fetchImpl,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
    })(webhookPayload(pullRequestBody()), { deliveryId: "delivery-failed", attempt: 1 });

    expect(outcome).toEqual({ status: "failed", errorCode: "GITHUB_API_FAILED" });
    expect(postedStatuses(fetchImpl).at(0)).toEqual({ sha: "abc123", state: "pending" });
    expect(postedStatuses(fetchImpl).at(-1)).toEqual({ sha: "abc123", state: "error" });
  });

  it("closed PR のコメント削除が失敗しても、共有 SHA の open PR を error にしない", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      const path = new URL(url).pathname;
      if (url.endsWith("/access_tokens")) {
        return Promise.resolve(jsonResponse({ token: "installation-token", expires_at: "2026-07-16T01:00:00Z" }, 201));
      }
      if (path.endsWith("/pulls/7")) {
        return Promise.resolve(
          jsonResponse({ title: "feat: merged PR", state: "closed", head: { sha: "abc123" }, draft: false }, 200)
        );
      }
      if (path.endsWith("/commits/abc123/pulls")) {
        return Promise.resolve(
          jsonResponse(
            [{ number: 8, title: "fix: keep valid PR", state: "open", head: { sha: "abc123" }, draft: false }],
            200
          )
        );
      }
      if (path === "/app") return Promise.resolve(jsonResponse({ slug: "preflight" }, 200));
      if (path.startsWith("/users/")) return Promise.resolve(jsonResponse({ id: 4242 }, 200));
      if (path.startsWith("/repos/owner/repo/statuses/") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({}, 201));
      }
      if (path.endsWith("/comments") && init?.method === "GET") {
        return Promise.resolve(
          jsonResponse(
            [
              {
                id: 10,
                body: "### Pull Request のタイトルを修正してください\n\nold",
                user: { id: 4242 },
              },
            ],
            200
          )
        );
      }
      if (path.endsWith("/comments/10") && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ message: "comment deletion failed" }, 500));
      }
      return Promise.reject(new Error(`Unexpected GitHub request: ${String(init?.method)} ${url}`));
    });

    const body = pullRequestBody({ action: "closed", title: "feat: merged PR" });
    const outcome = await composeGitHubWebhookProcessor(env(), {
      fetchImpl,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
    })(webhookPayload(body), { deliveryId: "delivery-closed-shared-head", attempt: 1 });

    expect(outcome).toEqual({ status: "failed", errorCode: "GITHUB_API_FAILED" });
    expect(postedStatuses(fetchImpl)).toEqual([
      { sha: "abc123", state: "pending" },
      { sha: "abc123", state: "success" },
      { sha: "abc123", state: "success" },
    ]);
  });

  it("環境変数が不正なときは 500 を返し、configKey と configReason を log へ出す", async () => {
    const logger = new RecordingLogger();
    const bindings: Env = { LOG_LEVEL: "invalid" };
    const app = composeApp({ logger });

    const webhook = await app.request(await webhookRequest("{}"), undefined, bindings);

    expect(webhook.status).toBe(500);
    expect(logger.records.at(-1)?.record).toMatchObject({
      result: "internal_error",
      configKey: "LOG_LEVEL",
      configReason: "invalid",
    });
  });

  it("GITHUB_WEBHOOK_SECRET 未設定は署名検証の failure に丸めず、composeApp 境界で configKey を出す", async () => {
    // secret 欠落は producer の signature_verification_failed 経路ではなく設定エラーとして扱われるべきで、
    // これは createQueuedGitHubWebhookHandler 単体でなく composeApp を通した経路として固定する
    const logger = new RecordingLogger();
    const bindings: Env = { ...env(), GITHUB_WEBHOOK_SECRET: "" };
    const app = composeApp({ logger });

    const webhook = await app.request(await webhookRequest(pullRequestBody()), undefined, bindings);

    expect(webhook.status).toBe(500);
    await expect(webhook.json()).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(logger.records.at(-1)).toMatchObject({
      level: "error",
      record: {
        event: "github_webhook_receive",
        result: "internal_error",
        configKey: "GITHUB_WEBHOOK_SECRET",
        configReason: "missing",
      },
    });
  });

  it("Queue binding がないときは publish failure として 503 と構造化 log を返す", async () => {
    const logger = new RecordingLogger();
    const bindings = env();
    const app = composeApp({ logger });

    const webhook = await app.request(await webhookRequest(pullRequestBody()), undefined, bindings);

    expect(webhook.status).toBe(503);
    await expect(webhook.json()).resolves.toEqual({ ok: false, code: "INTERNAL_ERROR" });
    expect(logger.records.at(-1)).toMatchObject({
      level: "error",
      record: {
        event: "github_webhook_enqueue",
        result: "queue_publish_failed",
        deliveryId: "delivery-1",
        errorCode: "Error",
      },
    });
  });

  it("processor の生成後に検出した設定エラーを failed outcome と log へ変換する", async () => {
    const logger = new RecordingLogger();
    const processor = composeGitHubWebhookProcessor({ LOG_LEVEL: "invalid" }, { logger });

    const outcome = await processor(webhookPayload(pullRequestBody()), {
      deliveryId: "delivery-invalid-config",
      attempt: 1,
    });

    expect(outcome).toEqual({ status: "failed", errorCode: "INTERNAL_ERROR" });
    expect(logger.records.at(-1)?.record).toMatchObject({
      result: "internal_error",
      deliveryId: "delivery-invalid-config",
      configKey: "LOG_LEVEL",
      configReason: "invalid",
    });
  });

  it("GitHub の失敗は処理済みとして記録せず、secret と request body を log へ出さない", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "permission denied" }, 403, { "x-github-request-id": "request-id" }));
    const cacheStorage = new MemoryCacheStorage();
    const logger = new RecordingLogger();
    const body = pullRequestBody({ author: "safe-author" });
    const bindings = env();
    const processor = composeGitHubWebhookProcessor(bindings, { fetchImpl, cacheStorage, logger });

    const outcome = await processor(webhookPayload(body), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome).toEqual({ status: "failed", errorCode: "GITHUB_AUTH_FAILED" });
    expect(cacheStorage.cache.entries.size).toBe(0);
    const logs = JSON.stringify(logger.records);
    expect(logs).toContain("github_auth_failed");
    expect(logs).toContain("request-id");
    expect(logs).not.toContain(TEST_WEBHOOK_SECRET);
    expect(logs).not.toContain(privateKeyPem);
    expect(logs).not.toContain(body);
    // defense-in-depth の検証
    // request.ts は 403 body を parse せず固定 message を使うため本 assertion 単体は trivially-true 寄りで、error body 非 log の実防御は logging.test.ts 側で担保する
    expect(logs).not.toContain("permission denied");
  });

  it("全 open PR fallback の totalCount 不一致警告を、composition が配線した Logger 経由で deliveryId 付きで記録する", async () => {
    // commit-associated PR API を空にして GraphQL の全 open PR fallback を強制し、page ごとに totalCount が変わる状況を再現する
    let graphQlPullRequestsCall = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/access_tokens")) {
        return Promise.resolve(jsonResponse({ token: "installation-token", expires_at: "2026-07-16T01:00:00Z" }, 201));
      }
      if (url.endsWith("/assignees")) {
        return Promise.resolve(jsonResponse({ assignees: [{ login: "author" }] }, 201));
      }
      if (new URL(url).pathname.endsWith("/pulls/7")) {
        return Promise.resolve(
          jsonResponse(
            { title: "feat: add auto assignment", state: "open", head: { sha: "abc123" }, draft: false },
            200
          )
        );
      }
      if (new URL(url).pathname.endsWith("/commits/abc123/pulls")) {
        // default branch 上の commit を想定し、commit-associated API は空を返して fallback を強制する
        return Promise.resolve(jsonResponse([], 200));
      }
      if (new URL(url).pathname === "/graphql") {
        if (requestBody(init).includes("PullRequestTitleStatuses")) {
          return Promise.resolve(jsonResponse(commitTitleStatusesResponse(), 200));
        }
        graphQlPullRequestsCall += 1;
        // 1 page 目は totalCount 2、2 page 目（最終 page）は totalCount 1 を返し、pagination 中の増減を再現する
        return Promise.resolve(
          graphQlPullRequestsCall % 2 === 1
            ? jsonResponse(
                {
                  data: {
                    repository: {
                      pullRequests: {
                        totalCount: 2,
                        nodes: [
                          {
                            number: 7,
                            title: "feat: add auto assignment",
                            state: "OPEN",
                            headRefOid: "abc123",
                            isDraft: false,
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "next" },
                      },
                    },
                  },
                },
                200
              )
            : jsonResponse(
                {
                  data: {
                    repository: {
                      pullRequests: { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                    },
                  },
                },
                200
              )
        );
      }
      if (new URL(url).pathname === "/app") {
        return Promise.resolve(jsonResponse({ slug: "preflight" }, 200));
      }
      if (new URL(url).pathname.startsWith("/users/")) {
        return Promise.resolve(jsonResponse({ id: 4242 }, 200));
      }
      if (new URL(url).pathname.startsWith("/repos/owner/repo/statuses/") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({}, 201));
      }
      if (url.includes("/comments") && init?.method === "GET") return Promise.resolve(jsonResponse([], 200));
      return Promise.reject(new Error(`Unexpected GitHub request: ${String(init?.method)} ${url}`));
    });
    const logger = new RecordingLogger();
    const processor = composeGitHubWebhookProcessor(env(), {
      fetchImpl,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
      logger,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });

    const outcome = await processor(webhookPayload(pullRequestBody()), {
      deliveryId: "delivery-total-count-mismatch",
      attempt: 1,
    });

    expect(outcome).toEqual({ status: "processed", result: "assigned" });
    expect(
      logger.records.some(
        ({ level, record }) =>
          level === "warn" &&
          record.result === "open_pull_request_total_count_mismatch" &&
          record.deliveryId === "delivery-total-count-mismatch" &&
          record.repository === "owner/repo"
      )
    ).toBe(true);
  });

  it("無効な title で説明コメントを作成し、title が有効に修正されたら削除して status を success にする", async () => {
    let ownComment: { id: number; body: string; user: { id: number } } | undefined;
    let currentTitle = "feat: Add login";
    const statusWrites: { sha: string; state: string; description: string }[] = [];
    const requests: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      requests.push(`${String(init?.method)} ${url}`);
      if (url.endsWith("/access_tokens")) {
        return Promise.resolve(jsonResponse({ token: "installation-token", expires_at: "2026-07-16T01:00:00Z" }, 201));
      }
      if (url.endsWith("/assignees")) return Promise.resolve(jsonResponse({ assignees: [{ login: "author" }] }, 201));
      if (new URL(url).pathname.endsWith("/pulls/7")) {
        return Promise.resolve(
          jsonResponse({ title: currentTitle, state: "open", head: { sha: "abc123" }, draft: false }, 200)
        );
      }
      if (new URL(url).pathname.endsWith("/commits/abc123/pulls")) {
        return Promise.resolve(
          jsonResponse([{ number: 7, title: currentTitle, state: "open", head: { sha: "abc123" }, draft: false }], 200)
        );
      }
      if (new URL(url).pathname === "/graphql") {
        if (requestBody(init).includes("PullRequestTitleStatuses")) {
          return Promise.resolve(jsonResponse(commitTitleStatusesResponse(), 200));
        }
        return Promise.resolve(
          jsonResponse(
            {
              data: {
                repository: {
                  pullRequests: {
                    totalCount: 1,
                    nodes: [{ number: 7, title: currentTitle, state: "OPEN", headRefOid: "abc123", isDraft: false }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
            200
          )
        );
      }
      if (new URL(url).pathname === "/app") {
        return Promise.resolve(jsonResponse({ slug: "preflight" }, 200));
      }
      if (new URL(url).pathname.startsWith("/users/")) {
        return Promise.resolve(jsonResponse({ id: 4242 }, 200));
      }
      if (new URL(url).pathname.startsWith("/repos/owner/repo/statuses/") && init?.method === "POST") {
        const body = JSON.parse(requestBody(init)) as Record<string, unknown> & { state: string };
        const sha = new URL(url).pathname.split("/").at(-1) ?? "";
        statusWrites.push({ sha, state: body.state, description: String(body.description) });
        return Promise.resolve(jsonResponse({}, 201));
      }
      if (new URL(url).pathname.endsWith("/comments") && init?.method === "GET") {
        return Promise.resolve(jsonResponse(ownComment ? [ownComment] : [], 200));
      }
      if (url.endsWith("/comments") && init?.method === "POST") {
        const body = JSON.parse(requestBody(init)) as { body: string };
        ownComment = { id: 10, body: body.body, user: { id: 4242 } };
        return Promise.resolve(jsonResponse(ownComment, 201));
      }
      if (url.endsWith("/comments/10") && init?.method === "DELETE") {
        ownComment = undefined;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unexpected GitHub request: ${String(init?.method)} ${url}`));
    });
    const bindings = env();
    const processor = composeGitHubWebhookProcessor(bindings, {
      fetchImpl,
      cacheStorage: new MemoryCacheStorage(),
      appBotIdentityCache: new Map(),
    });

    const invalid = pullRequestBody({ title: "feat: Add login" });
    const invalidOutcome = await processor(webhookPayload(invalid), { deliveryId: "delivery-invalid", attempt: 1 });
    expect(invalidOutcome.status, requests.join("\n")).toBe("processed");
    expect(ownComment?.body).toContain("Pull Request のタイトルを修正してください");

    currentTitle = "feat: add login";
    const validEdit = pullRequestBody({ action: "edited", title: "feat: add login", titleChanged: true });
    const validOutcome = await processor(webhookPayload(validEdit), { deliveryId: "delivery-valid", attempt: 1 });

    expect(validOutcome.status).toBe("processed");
    expect(statusWrites.filter((write) => write.sha === "abc123").map((write) => write.state)).toEqual([
      "pending",
      "failure",
      "pending",
      "success",
    ]);
    // sweep が query -> parse -> POST まで通っていることを確認する
    expect(statusWrites.filter((write) => write.sha === "stale-sha")).toEqual([
      { sha: "stale-sha", state: "success", description: "PR の最新 commit ではありません" },
      { sha: "stale-sha", state: "success", description: "PR の最新 commit ではありません" },
    ]);
    expect(ownComment).toBeUndefined();
    expect(fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/access_tokens"))).toHaveLength(2);
    expect(fetchImpl.mock.calls.filter(([input]) => new URL(requestUrl(input)).pathname === "/app")).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter(([input]) => new URL(requestUrl(input)).pathname.startsWith("/users/"))
    ).toHaveLength(1);
  });

  it("producer は GitHub を呼ばずに署名検証済みの delivery を enqueue する", async () => {
    // producer と consumer は別 colo で動くため、producer からは delivery cache も GitHub API も参照しない
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      return Promise.reject(new Error(`Unexpected GitHub request: ${String(init?.method)} ${requestUrl(input)}`));
    });
    const sent: unknown[] = [];
    const bindings: Env = {
      ...env(),
      GITHUB_WEBHOOK_QUEUE: {
        send: (message: unknown) => {
          sent.push(message);
          return Promise.resolve();
        },
      } as unknown as Env["GITHUB_WEBHOOK_QUEUE"],
    };
    const app = composeApp({ fetchImpl, cacheStorage: new MemoryCacheStorage(), appBotIdentityCache: new Map() });
    const body = pullRequestBody();

    const first = await app.request(await webhookRequest(body, "delivery-pending"), undefined, bindings);
    const redelivered = await app.request(await webhookRequest(body, "delivery-pending"), undefined, bindings);

    expect(first.status).toBe(202);
    expect(redelivered.status).toBe(202);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { version: 1, event: "pull_request", deliveryId: "delivery-pending", body },
      { version: 1, event: "pull_request", deliveryId: "delivery-pending", body },
    ]);
  });
});
