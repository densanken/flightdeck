import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";

import type { Env } from "./env.js";

const handler = vi.fn(() => Promise.resolve(Response.json({ ok: true }, { status: 202 })));
const app = createApp({ createWebhookHandler: () => handler });
const env = {} as Env;
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;

describe("createApp", () => {
  it("POST を handler に渡す", async () => {
    const response = await app.fetch(
      new Request("https://example.com/webhooks/github", { method: "POST" }),
      env,
      context
    );

    expect(response.status).toBe(202);
    expect(handler).toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("非 POST は 405、未知の path は 404 を返す", async () => {
    const invalid = await app.fetch(new Request("https://example.com/webhooks/github"), env, context);

    expect(invalid.status).toBe(405);
    expect(invalid.headers.get("allow")).toBe("POST");

    const missing = await app.fetch(new Request("https://example.com/unknown"), env, context);

    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });
});
