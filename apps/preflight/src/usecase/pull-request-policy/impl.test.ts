import { describe, expect, it, vi } from "vitest";

import { PullRequestPolicyUseCaseImpl } from "./impl.js";

import type { PullRequestPolicyDependencies, PullRequestPolicyGateway } from "./dependencies.js";
import type { PullRequestPolicyCommand } from "./interface.js";
import type { DeliveryRepository, WebhookFeature } from "../../repository/delivery/interface.js";
import type { AssignmentOutcome } from "../assignment/interface.js";
import type { TitleValidationOutcome } from "../title-validation/interface.js";

class MemoryDeliveryRepository implements DeliveryRepository {
  readonly processed = new Set<string>();
  failReadFeature: WebhookFeature | undefined;
  failWriteFeature: WebhookFeature | undefined;

  has(deliveryId: string, feature: WebhookFeature): Promise<boolean> {
    if (feature === this.failReadFeature) return Promise.reject(new Error("read failed"));
    return Promise.resolve(this.processed.has(`${deliveryId}:${feature}`));
  }

  markProcessed(deliveryId: string, feature: WebhookFeature): Promise<void> {
    if (feature === this.failWriteFeature) return Promise.reject(new Error("write failed"));
    this.processed.add(`${deliveryId}:${feature}`);
    return Promise.resolve();
  }
}

const command = (overrides: Partial<PullRequestPolicyCommand> = {}): PullRequestPolicyCommand => ({
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
  ...overrides,
});

const validTitleOutcome = (): TitleValidationOutcome => ({
  result: "valid",
  comment: "none",
  commentsDeleted: 0,
  duplicateCommentsDeleted: 0,
  supersededStatusesCleared: 0,
  supersededSweepFailed: false,
});

const createUseCase = (
  input: {
    repository?: MemoryDeliveryRepository;
    assignmentOutcome?: AssignmentOutcome;
    titleOutcome?: TitleValidationOutcome;
    assignmentError?: Error;
    titleError?: Error;
  } = {}
) => {
  const repository = input.repository ?? new MemoryDeliveryRepository();
  const gateway = {} as PullRequestPolicyGateway;
  const createGateway = vi.fn(() => gateway);
  const assignmentExecute = input.assignmentError
    ? vi.fn().mockRejectedValue(input.assignmentError)
    : vi.fn().mockResolvedValue(input.assignmentOutcome ?? { result: "assigned" });
  const titleExecute = input.titleError
    ? vi.fn().mockRejectedValue(input.titleError)
    : vi.fn().mockResolvedValue(input.titleOutcome ?? validTitleOutcome());
  const createAssignmentUseCase = vi.fn(() => ({ execute: assignmentExecute }));
  const createTitleValidationUseCase = vi.fn(() => ({ execute: titleExecute }));
  const dependencies: PullRequestPolicyDependencies = {
    deliveryRepository: repository,
    createGateway,
    createAssignmentUseCase,
    createTitleValidationUseCase,
    now: () => new Date("2026-07-16T00:00:00.000Z"),
  };
  return {
    useCase: new PullRequestPolicyUseCaseImpl(dependencies),
    repository,
    gateway,
    createGateway,
    createAssignmentUseCase,
    createTitleValidationUseCase,
    assignmentExecute,
    titleExecute,
  };
};

describe("PullRequestPolicyUseCaseImpl", () => {
  it("opened では両方の機能を実行し、delivery を機能ごとに処理済みとして記録する", async () => {
    const fixture = createUseCase();

    const outcome = await fixture.useCase.execute(command(), new AbortController().signal);

    expect(outcome.features).toEqual([
      { feature: "auto-assign", outcome: "processed", result: "assigned" },
      { feature: "title-validation", outcome: "processed", ...validTitleOutcome() },
    ]);
    expect(fixture.repository.processed).toEqual(new Set(["delivery-1:auto-assign", "delivery-1:title-validation"]));
    expect(fixture.createGateway).toHaveBeenCalledOnce();
    expect(fixture.createAssignmentUseCase).toHaveBeenCalledWith(fixture.gateway);
    expect(fixture.createTitleValidationUseCase).toHaveBeenCalledWith(fixture.gateway);
    expect(fixture.assignmentExecute).toHaveBeenCalledOnce();
    expect(fixture.titleExecute).toHaveBeenCalledOnce();
  });

  it("edited は title 変更時だけ実行し、synchronize, ready_for_review, converted_to_draft, closed では title 検証だけを実行する", async () => {
    const ignored = createUseCase();
    await expect(
      ignored.useCase.execute(command({ action: "edited", titleChanged: false }), new AbortController().signal)
    ).resolves.toMatchObject({ features: [], result: "ignored_action" });
    expect(ignored.createGateway).not.toHaveBeenCalled();

    const edited = createUseCase();
    await expect(
      edited.useCase.execute(command({ action: "edited", titleChanged: true }), new AbortController().signal)
    ).resolves.toMatchObject({ features: [expect.objectContaining({ feature: "title-validation" })] });
    expect(edited.assignmentExecute).not.toHaveBeenCalled();
    expect(edited.titleExecute).toHaveBeenCalledOnce();

    const synchronized = createUseCase();
    await synchronized.useCase.execute(
      command({ action: "synchronize", previousHeadSha: "previous-sha" }),
      new AbortController().signal
    );
    expect(synchronized.titleExecute).toHaveBeenCalledWith(
      {
        owner: "owner",
        repo: "repo",
        pullRequestNumber: 7,
        fallbackHeadSha: "abc123",
        previousHeadSha: "previous-sha",
      },
      expect.any(AbortSignal),
      expect.any(AbortSignal)
    );
    expect(synchronized.assignmentExecute).not.toHaveBeenCalled();

    const ready = createUseCase();
    await ready.useCase.execute(command({ action: "ready_for_review" }), new AbortController().signal);
    expect(ready.titleExecute).toHaveBeenCalledOnce();
    expect(ready.assignmentExecute).not.toHaveBeenCalled();

    // draft へ戻した PR を放置すると、同じ head の別 PR が gate から外れた PR の status で塞がれ続ける
    const convertedToDraft = createUseCase({ titleOutcome: { ...validTitleOutcome(), result: "held" } });
    await expect(
      convertedToDraft.useCase.execute(command({ action: "converted_to_draft" }), new AbortController().signal)
    ).resolves.toMatchObject({ result: "title_held" });
    expect(convertedToDraft.titleExecute).toHaveBeenCalledOnce();
    expect(convertedToDraft.assignmentExecute).not.toHaveBeenCalled();

    const closed = createUseCase({
      titleOutcome: { ...validTitleOutcome(), result: "closed" },
    });
    await closed.useCase.execute(command({ action: "closed" }), new AbortController().signal);
    expect(closed.titleExecute).toHaveBeenCalledOnce();
    expect(closed.assignmentExecute).not.toHaveBeenCalled();
  });

  it("bot が作成した PR では auto-assign を skip しつつ title 検証は実行する", async () => {
    const fixture = createUseCase({ assignmentOutcome: { result: "skipped_bot" } });

    const outcome = await fixture.useCase.execute(
      command({ author: "renovate[bot]", authorType: "Bot" }),
      new AbortController().signal
    );

    expect(outcome.features[0]).toMatchObject({ feature: "auto-assign", result: "skipped_bot" });
    expect(outcome.features[1]).toMatchObject({ feature: "title-validation", result: "valid" });
    expect(fixture.assignmentExecute).toHaveBeenCalledOnce();
    expect(fixture.titleExecute).toHaveBeenCalledOnce();
  });

  it("cache に記録済みでない機能だけを実行し、記録済みの機能は duplicate にする", async () => {
    const repository = new MemoryDeliveryRepository();
    repository.processed.add("delivery-1:auto-assign");
    const fixture = createUseCase({ repository });

    const outcome = await fixture.useCase.execute(command(), new AbortController().signal);

    expect(outcome.features[0]).toEqual({ feature: "auto-assign", outcome: "duplicate" });
    expect(outcome.features[1]).toMatchObject({ feature: "title-validation", outcome: "processed" });
    expect(fixture.assignmentExecute).not.toHaveBeenCalled();
    expect(fixture.titleExecute).toHaveBeenCalledOnce();
  });

  it("片方の機能が失敗しても、成功した機能だけを処理済みとして記録する", async () => {
    const fixture = createUseCase({ titleError: new Error("check run failed") });

    const outcome = await fixture.useCase.execute(command(), new AbortController().signal);

    expect(outcome.features[0]).toMatchObject({ feature: "auto-assign", outcome: "processed" });
    expect(outcome.features[1]).toMatchObject({ feature: "title-validation", outcome: "failed" });
    expect(fixture.repository.processed.has("delivery-1:auto-assign")).toBe(true);
    expect(fixture.repository.processed.has("delivery-1:title-validation")).toBe(false);
  });

  it("delivery cache の失敗では処理を続け、機能ごとの warning を返す", async () => {
    const repository = new MemoryDeliveryRepository();
    repository.failReadFeature = "auto-assign";
    repository.failWriteFeature = "title-validation";
    const fixture = createUseCase({ repository });

    const outcome = await fixture.useCase.execute(command(), new AbortController().signal);

    expect(outcome.warnings).toEqual([
      { feature: "auto-assign", code: "delivery_lookup_failed" },
      { feature: "title-validation", code: "delivery_record_failed" },
    ]);
  });
});
