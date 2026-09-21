import { describe, expect, it } from "vitest";

import { logFeatureFailure, logFeatureResult } from "./logging.js";
import { ConfigurationError, GitHubError } from "../../errors.js";
import { RecordingLogger } from "../../test-helper/platform.js";
import { TitleValidationExecutionError } from "../../usecase/title-validation/errors.js";

describe("logFeatureFailure", () => {
  it("GitHub の error は body と message を除いた安全な metadata だけを log へ出す", () => {
    const logger = new RecordingLogger();
    // GitHub の error body 相当の文字列を message に含めても log へ出ないことを sentinel で検証する
    const githubError = new GitHubError("GITHUB_API_FAILED", "permission denied", 403, "req-1", "30");

    logFeatureFailure({ feature: "title-validation", outcome: "failed", error: githubError }, logger, {}, Date.now());

    const record = logger.records.at(-1);
    expect(record?.level).toBe("error");
    expect(record?.record).toMatchObject({
      event: "github_webhook_consume",
      result: "github_api_failed",
      feature: "title-validation",
      errorCode: "GITHUB_API_FAILED",
      githubStatus: 403,
      githubRequestId: "req-1",
      retryAfter: "30",
    });
    expect(JSON.stringify(logger.records)).not.toContain("permission denied");
  });

  it("TitleValidationExecutionError は stage を result として展開し、内側の message は落とす", () => {
    const logger = new RecordingLogger();
    const githubError = new GitHubError("GITHUB_API_FAILED", "leaked github body", 502, "req-2", "10");
    const wrapped = new TitleValidationExecutionError("status_failed", githubError);

    logFeatureFailure({ feature: "title-validation", outcome: "failed", error: wrapped }, logger, {}, Date.now());

    expect(logger.records.at(-1)?.record).toMatchObject({
      result: "status_failed",
      errorCode: "GITHUB_API_FAILED",
      githubStatus: 502,
      githubRequestId: "req-2",
      retryAfter: "10",
    });
    expect(JSON.stringify(logger.records)).not.toContain("leaked github body");
  });

  it("設定不備は値を出さず key と reason だけを log へ出す", () => {
    const logger = new RecordingLogger();
    const configurationError = new ConfigurationError("GITHUB_WEBHOOK_SECRET", "missing");

    logFeatureFailure({ feature: "auto-assign", outcome: "failed", error: configurationError }, logger, {}, Date.now());

    expect(logger.records.at(-1)?.record).toMatchObject({
      result: "internal_error",
      errorCode: "INTERNAL_ERROR",
      configKey: "GITHUB_WEBHOOK_SECRET",
      configReason: "missing",
    });
  });

  it("error の log にも delivery の文脈と開始からの経過時間を付ける", () => {
    const logger = new RecordingLogger();
    const context = { deliveryId: "delivery-1", repository: "owner/repo", pullRequestNumber: 7 };

    logFeatureFailure(
      { feature: "auto-assign", outcome: "failed", error: new GitHubError("GITHUB_API_FAILED", "failed") },
      logger,
      context,
      Date.now() - 1_000
    );

    expect(logger.records.at(-1)?.record).toMatchObject(context);
    expect(logger.records.at(-1)?.record.durationMs).toBeGreaterThanOrEqual(1_000);
  });
});

describe("logFeatureResult", () => {
  const resultsOf = (logger: RecordingLogger) => logger.records.map((entry) => [entry.level, entry.record.result]);

  it("重複 delivery は duplicate_delivery だけを 1 件出し、機能の result は出さない", () => {
    const logger = new RecordingLogger();

    logFeatureResult({ feature: "title-validation", outcome: "duplicate" }, logger, {}, Date.now());

    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]?.level).toBe("info");
    expect(logger.records[0]?.record).toMatchObject({
      event: "github_webhook_consume",
      result: "duplicate_delivery",
      feature: "title-validation",
    });
  });

  it("auto-assign は機能の result を 1 件だけ出す", () => {
    const logger = new RecordingLogger();

    logFeatureResult({ feature: "auto-assign", outcome: "processed", result: "assigned" }, logger, {}, Date.now());

    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]?.level).toBe("info");
    expect(logger.records[0]?.record).toMatchObject({
      event: "github_webhook_consume",
      result: "assigned",
      feature: "auto-assign",
    });
  });

  it("title-validation はコメントと status に変化がなければ result を 1 件だけ出す", () => {
    const logger = new RecordingLogger();

    logFeatureResult(
      {
        feature: "title-validation",
        outcome: "processed",
        result: "valid",
        comment: "none",
        commentsDeleted: 0,
        duplicateCommentsDeleted: 0,
        supersededStatusesCleared: 0,
        supersededSweepFailed: false,
      },
      logger,
      {},
      Date.now()
    );

    expect(resultsOf(logger)).toEqual([["info", "valid"]]);
  });

  it("title-validation は result の後にコメントと status の後続 log を順序どおり出す", () => {
    const logger = new RecordingLogger();

    logFeatureResult(
      {
        feature: "title-validation",
        outcome: "processed",
        result: "invalid",
        comment: "created",
        commentsDeleted: 2,
        duplicateCommentsDeleted: 3,
        supersededStatusesCleared: 4,
        supersededSweepFailed: true,
      },
      logger,
      {},
      Date.now()
    );

    expect(resultsOf(logger)).toEqual([
      ["info", "invalid"],
      ["info", "comment_created"],
      ["info", "comment_deleted"],
      ["info", "duplicate_comments_deleted"],
      ["info", "superseded_statuses_cleared"],
      ["warn", "superseded_sweep_failed"],
    ]);
    expect(logger.records[2]?.record.commentCount).toBe(2);
    expect(logger.records[3]?.record.commentCount).toBe(3);
    expect(logger.records[4]?.record.commitCount).toBe(4);
    expect(logger.records.every((entry) => entry.record.feature === "title-validation")).toBe(true);
  });

  it("既存コメントの更新は comment_updated として出す", () => {
    const logger = new RecordingLogger();

    logFeatureResult(
      {
        feature: "title-validation",
        outcome: "processed",
        result: "invalid",
        comment: "updated",
        commentsDeleted: 0,
        duplicateCommentsDeleted: 1,
        supersededStatusesCleared: 0,
        supersededSweepFailed: false,
      },
      logger,
      {},
      Date.now()
    );

    // このテスト固有の関心は comment: "updated" がどの log になるかだけなので、コメント系の log に絞って固定する
    // 出力全体の順序と件数は「result の後にコメントと status の後続 log を順序どおり出す」が固定する
    const commentResults = resultsOf(logger).filter(
      ([, result]) => result === "comment_created" || result === "comment_updated"
    );
    expect(commentResults).toEqual([["info", "comment_updated"]]);
  });

  it("機能の log に delivery の文脈と開始からの経過時間を付ける", () => {
    const logger = new RecordingLogger();
    const context = { deliveryId: "delivery-1", repository: "owner/repo", pullRequestNumber: 7 };

    logFeatureResult(
      { feature: "auto-assign", outcome: "processed", result: "assigned" },
      logger,
      context,
      Date.now() - 1_000
    );

    expect(logger.records[0]?.record).toMatchObject(context);
    expect(logger.records[0]?.record.durationMs).toBeGreaterThanOrEqual(1_000);
  });
});
