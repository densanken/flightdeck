import { describe, expect, it, vi } from "vitest";

import { parsePullRequestWebhookPayload } from "./payload.js";
import { createGitHubWebhookProcessor } from "./webhook.js";
import { GitHubError } from "../../errors.js";
import { RecordingLogger } from "../../test-helper/platform.js";
import { TitleValidationExecutionError } from "../../usecase/title-validation/errors.js";

import type { GitHubWebhookProcessorDependencies } from "./webhook.js";
import type {
  PullRequestPolicyOutcome,
  PullRequestPolicyUseCase,
} from "../../usecase/pull-request-policy/interface.js";

const payload = (overrides: Record<string, unknown> = {}) => {
  const parsed = parsePullRequestWebhookPayload({
    action: "opened",
    installation: { id: 42 },
    repository: { name: "repo", owner: { login: "owner" } },
    pull_request: {
      number: 7,
      title: "feat: add login",
      head: { sha: "abc123" },
      user: { login: "author", type: "User" },
      assignees: [],
    },
    ...overrides,
  });
  if (!parsed) throw new Error("Expected a valid payload");
  return parsed;
};

const successfulOutcome = (): PullRequestPolicyOutcome => ({
  result: "assigned",
  warnings: [],
  features: [
    { feature: "auto-assign", outcome: "processed", result: "assigned" },
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
  ],
});

const setup = (
  outcome: PullRequestPolicyOutcome = successfulOutcome(),
  overrides: Partial<GitHubWebhookProcessorDependencies> = {}
) => {
  const order: string[] = [];
  const execute = vi.fn<PullRequestPolicyUseCase["execute"]>().mockImplementation(() => {
    order.push("policy");
    return Promise.resolve(outcome);
  });
  const setPendingTitleStatus = vi
    .fn<NonNullable<GitHubWebhookProcessorDependencies["setPendingTitleStatus"]>>()
    .mockImplementation(() => {
      order.push("pending");
      return Promise.resolve();
    });
  const logger = new RecordingLogger();
  const hardDeadlineController = new AbortController();
  const softDeadlineController = new AbortController();
  const processor = createGitHubWebhookProcessor({
    policyUseCase: { execute },
    logger,
    createHardDeadlineSignal: () => hardDeadlineController.signal,
    createSoftDeadlineSignal: () => softDeadlineController.signal,
    setPendingTitleStatus,
    ...overrides,
  });
  return { processor, execute, logger, order, setPendingTitleStatus, hardDeadlineController, softDeadlineController };
};

describe("検証済み payload の処理", () => {
  it("delivery と PR の metadata を 1 つの policy command へまとめ、soft と hard の signal を分けて渡す", async () => {
    const { processor, execute, hardDeadlineController, softDeadlineController } = setup();

    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome).toEqual({ status: "processed", result: "assigned" });
    expect(execute).toHaveBeenCalledWith(
      {
        deliveryId: "delivery-1",
        action: "opened",
        titleChanged: false,
        installationId: 42,
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 7,
        fallbackHeadSha: "abc123",
        author: "author",
        authorType: "User",
        assignees: [],
      },
      expect.any(AbortSignal),
      hardDeadlineController.signal
    );
    const executionSignal = execute.mock.calls[0]?.[1];
    softDeadlineController.abort();
    expect(executionSignal?.aborted).toBe(true);
    expect(hardDeadlineController.signal.aborted).toBe(false);
  });

  it("synchronize のときだけ previousHeadSha を渡す", async () => {
    const { processor, execute } = setup();

    await processor(payload({ action: "synchronize", before: "old-sha" }), { deliveryId: "delivery-1", attempt: 1 });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "synchronize", fallbackHeadSha: "abc123", previousHeadSha: "old-sha" }),
      expect.any(AbortSignal),
      expect.any(AbortSignal)
    );
  });

  it("title を変更していない edited は ignored_edit を返し、log にも残す", async () => {
    const { processor, logger } = setup({ result: "ignored_action", warnings: [], features: [] });

    const outcome = await processor(payload({ action: "edited" }), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome).toEqual({ status: "processed", result: "ignored_edit" });
    expect(logger.records.at(-1)?.record.result).toBe("ignored_edit");
  });

  it("cache の warning を機能ごとに warn で残し、成功結果は変えない", async () => {
    const outcome = successfulOutcome();
    outcome.warnings = [
      { feature: "auto-assign", code: "delivery_lookup_failed" },
      { feature: "title-validation", code: "delivery_record_failed" },
    ];
    const { processor, logger } = setup(outcome);

    const result = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(result.status).toBe("processed");
    const warnings = logger.records.filter(({ level }) => level === "warn").map(({ record }) => record);
    expect(warnings.map((record) => record.result)).toEqual(["delivery_lookup_failed", "delivery_record_failed"]);
    expect(warnings.map((record) => record.feature)).toEqual(["auto-assign", "title-validation"]);
    expect(warnings.every((record) => record.event === "github_webhook_consume")).toBe(true);
  });

  it("title 検証の結果とコメント操作を log へ残し、title 本文は残さない", async () => {
    const title = "feat: Add @octocat.";
    const { processor, logger } = setup({
      result: "title_invalid",
      warnings: [],
      features: [
        {
          feature: "title-validation",
          outcome: "processed",
          result: "invalid",
          comment: "created",
          commentsDeleted: 0,
          duplicateCommentsDeleted: 0,
          supersededStatusesCleared: 0,
          supersededSweepFailed: false,
        },
      ],
    });

    const outcome = await processor(
      payload({
        pull_request: {
          number: 7,
          title,
          head: { sha: "abc123" },
          user: { login: "author", type: "User" },
          assignees: [],
        },
      }),
      { deliveryId: "delivery-1", attempt: 1 }
    );

    expect(outcome).toEqual({ status: "processed", result: "title_invalid" });
    expect(logger.records.map(({ record }) => record.result)).toEqual(["invalid", "comment_created"]);
    expect(JSON.stringify(logger.records)).not.toContain(title);
  });

  it("一部の機能が GitHub の失敗で落ちたときは failed と安全な metadata を返す", async () => {
    const error = new GitHubError("GITHUB_API_FAILED", "unsafe", 503, "request-id", "10");
    const { processor, logger } = setup({
      result: "assigned",
      warnings: [],
      features: [
        { feature: "auto-assign", outcome: "processed", result: "assigned" },
        {
          feature: "title-validation",
          outcome: "failed",
          error: new TitleValidationExecutionError("status_failed", error),
        },
      ],
    });

    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome).toEqual({ status: "failed", errorCode: "GITHUB_API_FAILED" });
    expect(logger.records.find(({ record }) => record.result === "status_failed")?.record).toMatchObject({
      feature: "title-validation",
      githubStatus: 503,
      githubRequestId: "request-id",
      retryAfter: "10",
    });
  });

  it("想定外の機能失敗は INTERNAL_ERROR にし、error message を log へ出さない", async () => {
    const { processor, logger } = setup({
      result: "ignored_action",
      warnings: [],
      features: [{ feature: "auto-assign", outcome: "failed", error: new Error("TOP_SECRET_ERROR") }],
    });

    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome).toEqual({ status: "failed", errorCode: "INTERNAL_ERROR" });
    expect(JSON.stringify(logger.records)).not.toContain("TOP_SECRET_ERROR");
  });

  it("usecase が throw したときは failed を返し、message を log へ出さない", async () => {
    const { processor, execute, logger } = setup();
    execute.mockRejectedValue(new Error("TOP_SECRET_ERROR"));

    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome).toEqual({ status: "failed", errorCode: "INTERNAL_ERROR" });
    expect(logger.records.at(-1)?.record.result).toBe("internal_error");
    expect(JSON.stringify(logger.records)).not.toContain("TOP_SECRET_ERROR");
  });
});

describe("検証開始時の pending status", () => {
  it("usecase を呼ぶ前に pending status を書く", async () => {
    const { processor, order, setPendingTitleStatus } = setup();

    await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(setPendingTitleStatus).toHaveBeenCalledWith(
      { installationId: 42, owner: "owner", repo: "repo", sha: "abc123" },
      expect.any(AbortSignal)
    );
    expect(order).toEqual(["pending", "policy"]);
  });

  it("title 検証を起動しない action では pending status を書かない", async () => {
    const { processor, setPendingTitleStatus, order } = setup();

    await processor(payload({ action: "labeled" }), { deliveryId: "delivery-1", attempt: 1 });

    expect(setPendingTitleStatus).not.toHaveBeenCalled();
    expect(order).toEqual(["policy"]);
  });

  it("処理済み delivery の再配信では pending を書かずに処理を続ける", async () => {
    const hasProcessedTitleValidation = vi.fn().mockResolvedValue(true);
    const { processor, logger, order, setPendingTitleStatus } = setup(successfulOutcome(), {
      hasProcessedTitleValidation,
    });

    await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(hasProcessedTitleValidation).toHaveBeenCalledWith("delivery-1", expect.any(AbortSignal));
    expect(setPendingTitleStatus).not.toHaveBeenCalled();
    expect(order).toEqual(["policy"]);
    expect(logger.records.some(({ record }) => record.result === "pending_status_skipped")).toBe(true);
  });

  it("retry された attempt では cache を引かずに pending を書かない", async () => {
    const hasProcessedTitleValidation = vi.fn().mockResolvedValue(false);
    const { processor, logger, order, setPendingTitleStatus } = setup(successfulOutcome(), {
      hasProcessedTitleValidation,
    });

    // 前の attempt が title-validation だけ処理済みにしている場合があり、別 colo の cache では判定できない
    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 2 });

    expect(outcome.status).toBe("processed");
    expect(setPendingTitleStatus).not.toHaveBeenCalled();
    expect(hasProcessedTitleValidation).not.toHaveBeenCalled();
    expect(order).toEqual(["policy"]);
    expect(logger.records.find(({ record }) => record.result === "pending_status_skipped")?.record).toMatchObject({
      reason: "retry",
    });
  });

  it("処理済みか判定できないときは pending を書かない", async () => {
    const { processor, logger, setPendingTitleStatus } = setup(successfulOutcome(), {
      hasProcessedTitleValidation: vi.fn().mockRejectedValue(new Error("cache down")),
    });

    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome.status).toBe("processed");
    expect(setPendingTitleStatus).not.toHaveBeenCalled();
    expect(logger.records.some(({ record }) => record.result === "pending_status_failed")).toBe(true);
  });

  it("pending status の失敗は log だけ残して検証を続ける", async () => {
    const { processor, logger, order } = setup(successfulOutcome(), {
      setPendingTitleStatus: vi.fn().mockRejectedValue(new Error("github down")),
    });

    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome.status).toBe("processed");
    expect(order).toEqual(["policy"]);
    // GitHub 障害と 2.5 秒の deadline 超過を alert 側で切り分けられるようにする
    expect(logger.records.find(({ record }) => record.result === "pending_status_failed")?.record).toMatchObject({
      timedOut: false,
    });
  });

  it("pending の deadline 超過は timedOut として log に残す", async () => {
    const pendingController = new AbortController();
    const { processor, logger } = setup(successfulOutcome(), {
      createPendingStatusSignal: () => pendingController.signal,
      setPendingTitleStatus: (_input, signal) => {
        pendingController.abort();
        return Promise.reject(signal.reason as Error);
      },
    });

    const outcome = await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    expect(outcome.status).toBe("processed");
    expect(logger.records.find(({ record }) => record.result === "pending_status_failed")?.record).toMatchObject({
      timedOut: true,
    });
  });

  it("pending の deadline は検証本体の signal と分ける", async () => {
    const pendingController = new AbortController();
    const { processor, execute, setPendingTitleStatus } = setup(successfulOutcome(), {
      createPendingStatusSignal: () => pendingController.signal,
    });

    await processor(payload(), { deliveryId: "delivery-1", attempt: 1 });

    const pendingSignal = setPendingTitleStatus.mock.calls[0]?.[1];
    const executionSignal = execute.mock.calls[0]?.[1];
    pendingController.abort();
    expect(pendingSignal?.aborted).toBe(true);
    expect(executionSignal?.aborted).toBe(false);
  });
});
