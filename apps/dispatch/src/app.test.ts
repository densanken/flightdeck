import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

import type { Env } from "./env.js";

const app = createApp({
  createWebhookHandler: () => () => Promise.resolve(Response.json({ ok: true }, { status: 202 })),
});
const env = {} as Env;

describe("createApp", () => {
  it("POST /webhooks/github を handler へ渡す", async () => {
    const response = await app.request("/webhooks/github", { method: "POST" }, env);

    expect(response.status).toBe(202);
  });

  it("webhook endpoint の非 POST は 405 と Allow を返す", async () => {
    const response = await app.request("/webhooks/github", { method: "GET" }, env);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("webhook endpoint の HEAD も 405 と Allow を返す", async () => {
    const response = await app.request("/webhooks/github", { method: "HEAD" }, env);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("未知の path は JSON の 404 を返す", async () => {
    const response = await app.request("/", {}, env);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("すべての response に cache と MIME sniffing の抑止 header を付ける", async () => {
    const response = await app.request("/nope", {}, env);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
