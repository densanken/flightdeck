import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./main.js";

import type { Env } from "./env.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("./composition/app.js", () => ({ composeApp: () => ({ fetch: mocks.fetch }) }));

describe("Worker entrypoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetch event を application へ委譲する", async () => {
    const request = new Request("https://takeoff.example.com/health");
    const env = {} as Env["Bindings"];
    const ctx = {} as ExecutionContext;
    const expected = new Response("ok");
    mocks.fetch.mockResolvedValueOnce(expected);

    await expect(worker.fetch(request, env, ctx)).resolves.toBe(expected);
    expect(mocks.fetch).toHaveBeenCalledWith(request, env, ctx);
  });
});
