import { describe, expect, it, vi } from "vitest";

import { getAuthenticatedAppBotUserId } from "./app-identity.js";

const input = (fetchImpl: typeof fetch) => ({
  appJwt: "app-jwt",
  installationToken: "installation-token",
  fetchImpl,
  signal: new AbortController().signal,
});

describe("getAuthenticatedAppBotUserId", () => {
  it("認証済み App の slug から bot account の user ID を解決し、request ごとに対応する token を使う", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ slug: "preflight" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 4242 }), { status: 200 }));

    await expect(getAuthenticatedAppBotUserId(input(fetchImpl))).resolves.toBe(4242);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.headers])).toEqual([
      ["https://api.github.com/app", expect.objectContaining({ Authorization: "Bearer app-jwt" })],
      [
        "https://api.github.com/users/preflight%5Bbot%5D",
        expect.objectContaining({ Authorization: "Bearer installation-token" }),
      ],
    ]);
  });

  it("App と bot の response が不正なら GITHUB_AUTH_FAILED で reject する", async () => {
    const malformedApp = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ slug: "../bad" }), { status: 200 }));
    await expect(getAuthenticatedAppBotUserId(input(malformedApp))).rejects.toMatchObject({
      code: "GITHUB_AUTH_FAILED",
    });

    const malformedBot = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ slug: "preflight" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "not-a-number" }), { status: 200 }));
    await expect(getAuthenticatedAppBotUserId(input(malformedBot))).rejects.toMatchObject({
      code: "GITHUB_AUTH_FAILED",
    });
  });
});
