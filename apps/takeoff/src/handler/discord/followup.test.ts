import { afterEach, describe, expect, it, vi } from "vitest";

import { editDeferredResponse } from "./followup.js";

describe("editDeferredResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Discord の error response は status だけを記録する", async () => {
    const interactionToken = "secret-interaction-token";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });

    await editDeferredResponse("application-id", interactionToken, { title: "Result" });

    expect(consoleErrorSpy).toHaveBeenCalledWith("discord_followup_http_error", { status: 500 });
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(interactionToken);
  });

  it("Discord request の例外から interaction token を記録しない", async () => {
    const interactionToken = "secret-interaction-token";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error(`https://discord.com/api/v10/webhooks/application-id/${interactionToken}/messages/@original`)
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });

    await editDeferredResponse("application-id", interactionToken, { title: "Result" });

    expect(consoleErrorSpy).toHaveBeenCalledWith("discord_followup_request_failed", { errorName: "Error" });
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(interactionToken);
  });

  it("上限を超える description は上限内の最後の改行で切る", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const description = ["a".repeat(4000), "b".repeat(200)].join("\n");

    await editDeferredResponse("application-id", "token", { description });

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as { embeds: { description: string }[] };
    expect(body.embeds[0]?.description).toBe(`${"a".repeat(4000)}\n…`);
  });

  it("改行の無い上限超えの description は、切る位置の絵文字を分断せずに切る", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    // 😀 は UTF-16 で 2 code unit なので、上限の 1 つ手前で切ると上位サロゲートだけが残る
    const description = `${"a".repeat(4094)}😀b`;

    await editDeferredResponse("application-id", "token", { description });

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as { embeds: { description: string }[] };
    expect(body.embeds[0]?.description).toBe(`${"a".repeat(4094)}…`);
  });
});
