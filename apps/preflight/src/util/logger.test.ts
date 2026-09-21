import { describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger.js";

const createSink = () => ({
  debug: vi.fn<(message: string) => void>(),
  info: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
});

describe("createLogger", () => {
  it("定義済みの field だけを logger.log の record として受け入れる", () => {
    const logger = createLogger("error", createSink());

    logger.log("info", { event: "github_webhook_queue", messageId: "message-1", attempts: 2 });
    // @ts-expect-error LogRecord は未知の field 名を許可しない
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

  it("最小 level 以上の record を level 付きの JSON にして対応する method へ出力する", () => {
    const sink = createSink();
    const logger = createLogger("warn", sink);

    logger.log("error", { event: "pull_request_policy", result: "internal_error", pullRequestNumber: 7 });

    expect(sink.error).toHaveBeenCalledTimes(1);
    const message = sink.error.mock.calls[0]?.[0] ?? "";
    // level が record の前に置かれ、record の field が JSON で残ることを固定文字列で検証する
    expect(message).toBe(
      '{"level":"error","event":"pull_request_policy","result":"internal_error","pullRequestNumber":7}'
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
});
