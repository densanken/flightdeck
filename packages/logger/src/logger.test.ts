import { describe, expect, it, vi } from "vitest";

import { createLogger } from "./index.js";

const createSink = () => ({
  debug: vi.fn<(message: string) => void>(),
  info: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
});

describe("createLogger", () => {
  it("型引数で渡した record 型の field だけを受け入れる", () => {
    const logger = createLogger<{ event: string; messageId?: string }>("error", createSink());

    logger.log("info", { event: "github_webhook_queue", messageId: "message-1" });
    // @ts-expect-error 型引数の record 型は未知の field 名を許可しない
    logger.log("info", { event: "github_webhook_queue", mesageId: "message-1" });
  });

  it("設定した最小 level 未満の record は出力しない", () => {
    const sink = createSink();
    const logger = createLogger("warn", sink);

    logger.log("info", { event: "github_webhook", result: "ping" });
    logger.log("debug", { event: "github_webhook" });

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
  });

  it("record が level や message を持っていても logger が付ける値で上書きする", () => {
    const sink = createSink();
    const logger = createLogger("info", sink);

    logger.log("info", { event: "github_api_failed", level: "debug", message: "overwritten" });

    expect(JSON.parse(sink.info.mock.calls[0]?.[0] ?? "")).toMatchObject({
      level: "info",
      message: "github_api_failed",
    });
  });

  it("最小 level 以上の record を level と message 付きの JSON にして対応する method へ出力する", () => {
    const sink = createSink();
    const logger = createLogger("warn", sink);

    logger.log("error", { event: "pull_request_policy", result: "internal_error", pullRequestNumber: 7 });

    expect(sink.error).toHaveBeenCalledTimes(1);
    const message = sink.error.mock.calls[0]?.[0] ?? "";
    // record の field が JSON で残り、logger が level と message を付けることを固定文字列で検証する
    expect(message).toBe(
      '{"event":"pull_request_policy","result":"internal_error","pullRequestNumber":7,"level":"error","message":"pull_request_policy"}'
    );
    expect(JSON.parse(message)).toMatchObject({ level: "error", event: "pull_request_policy", pullRequestNumber: 7 });
  });

  it("level 未指定のときは info を既定にし、debug を出力しない", () => {
    const sink = createSink();
    const logger = createLogger(undefined, sink);

    logger.log("debug", { event: "github_webhook" });
    logger.log("info", { event: "github_webhook", result: "ping" });

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledTimes(1);
  });

  it("引用符で囲まれた秘密情報を秘匿化しても、出力は JSON として読める", () => {
    const sink = createSink();
    const logger = createLogger("info", sink);

    logger.log("error", {
      event: "discord_request_failed",
      error: 'request to "https://discord.com/api/webhooks/123/secret-token" failed',
    });

    const message = sink.error.mock.calls[0]?.[0] ?? "";
    expect(JSON.parse(message)).toMatchObject({
      error: 'request to "https://discord.com/api/webhooks/123/<redacted>" failed',
    });
    expect(message).not.toContain("secret-token");
  });

  it("出力する JSON に含まれる秘密情報を秘匿化する", () => {
    const sink = createSink();
    const logger = createLogger("info", sink);

    logger.log("error", { event: "github_api_failed", body: "token ghs_1234567890abcdefghijklmnopqrstuvwxyz12" });

    expect(sink.error.mock.calls[0]?.[0]).not.toContain("ghs_");
  });
});
