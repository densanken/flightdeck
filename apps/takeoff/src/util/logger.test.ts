import { afterEach, describe, expect, it, vi } from "vitest";

import { logger, withLogContext } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withLogContext", () => {
  it("中で作った Promise の後続処理で出す log にも context の field を付ける", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });

    await withLogContext({ interactionId: "interaction-1" }, async () => {
      await withLogContext({ repoId: "101" }, async () => {
        await Promise.resolve();
        logger.log("error", { event: "discord_command_failed" });
      });
    });
    logger.log("error", { event: "outside" });

    expect(JSON.parse(error.mock.calls[0]?.[0] as string)).toMatchObject({
      event: "discord_command_failed",
      interactionId: "interaction-1",
      repoId: "101",
    });
    expect(JSON.parse(error.mock.calls[1]?.[0] as string)).not.toHaveProperty("interactionId");
  });

  it("run が戻った後に waitUntil の後続処理として出す log にも context の field を付ける", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    let resolveLater = (): void => undefined;
    const later = new Promise<void>((resolve) => {
      resolveLater = resolve;
    });

    // waitUntil へ渡す Promise と同じく、run の外で解決してから後続の log を出させる
    const pending = withLogContext({ interactionId: "interaction-2" }, async () => {
      await later;
      logger.log("error", { event: "discord_followup_request_failed" });
    });
    resolveLater();
    await pending;

    expect(JSON.parse(error.mock.calls[0]?.[0] as string)).toMatchObject({ interactionId: "interaction-2" });
  });
});
