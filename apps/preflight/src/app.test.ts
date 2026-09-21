import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";

const createTestApp = () => {
  const env = {};
  const handleGitHubWebhook = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockResolvedValue(new Response("webhook", { status: 200 }));
  const createGitHubWebhookHandler = vi.fn(() => handleGitHubWebhook);
  return { app: createApp({ createGitHubWebhookHandler }), createGitHubWebhookHandler, env, handleGitHubWebhook };
};

describe("createApp", () => {
  it("未知の path は 404、Webhook path の非 POST は 405 と Allow: POST を返し、handler を呼ばない", async () => {
    const { app, createGitHubWebhookHandler, env, handleGitHubWebhook } = createTestApp();
    const notFound = await app.request("/unknown", undefined, env);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("Cache-Control")).toBe("no-store");
    expect(notFound.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(notFound.json()).resolves.toEqual({ ok: false, code: "NOT_FOUND" });
    expect(handleGitHubWebhook).not.toHaveBeenCalled();
    expect(createGitHubWebhookHandler).not.toHaveBeenCalled();

    const webhookGet = await app.request("/webhooks/github", undefined, env);
    expect(webhookGet.status).toBe(405);
    expect(webhookGet.headers.get("Allow")).toBe("POST");
    expect(webhookGet.headers.get("Cache-Control")).toBe("no-store");
    expect(webhookGet.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const webhookHead = await app.request("/webhooks/github", { method: "HEAD" }, env);
    expect(webhookHead.status).toBe(405);
    expect(webhookHead.headers.get("Allow")).toBe("POST");
  });

  it("Webhook path の POST だけを handler へ委譲し、env は factory、raw Request は handler へ一度ずつ渡す", async () => {
    const { app, createGitHubWebhookHandler, env, handleGitHubWebhook } = createTestApp();
    const request = new Request("https://worker.example.com/webhooks/github", { method: "POST" });
    const response = await app.request(request, undefined, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(createGitHubWebhookHandler).toHaveBeenCalledOnce();
    expect(createGitHubWebhookHandler).toHaveBeenCalledWith(env);
    expect(handleGitHubWebhook).toHaveBeenCalledWith(request);
  });

  it("連続する request ごとに、その request の env から handler を生成する", async () => {
    const handledEnvironments: object[] = [];
    const app = createApp({
      createGitHubWebhookHandler: (requestEnv) => {
        handledEnvironments.push(requestEnv);
        return () => Promise.resolve(new Response("webhook", { status: 200 }));
      },
    });
    const firstEnv = { LOG_LEVEL: "info" };
    const secondEnv = { LOG_LEVEL: "error" };

    await app.request("https://worker.example.com/webhooks/github", { method: "POST" }, firstEnv);
    await app.request("https://worker.example.com/webhooks/github", { method: "POST" }, secondEnv);

    expect(handledEnvironments).toEqual([firstEnv, secondEnv]);
  });
});
