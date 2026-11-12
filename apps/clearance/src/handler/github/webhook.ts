import { REPOSITORY_PATTERN } from "@flightdeck/rules";
import { z } from "zod";

import { ConfigurationError } from "../../errors.js";

import type {
  ApprovalContext,
  ApprovalUseCase,
  ReviewCommitInput,
  ReviewPullRequestsInput,
} from "../../usecase/approval/interface.js";
import type { Logger } from "@flightdeck/logger";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  getBotUserId: () => number;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  createUseCase: (input: ApprovalContext) => ApprovalUseCase;
  waitUntil: (promise: Promise<void>) => void;
  logger: Logger;
}

const base = z.object({
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().regex(REPOSITORY_PATTERN) }),
  installation: z.object({ id: z.number().int().positive() }),
  sender: z.object({ id: z.number() }),
});

const action = base.extend({ action: z.string() });

const pull = action.extend({ number: z.number().int().positive() });

const review = action.extend({ pull_request: z.object({ number: z.number().int().positive() }) });

const issue = action.extend({
  issue: z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }),
});

const suite = action.extend({
  check_suite: z.object({
    head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
    pull_requests: z.array(z.object({ number: z.number().int().positive() })),
  }),
});

const status = base.extend({ sha: z.string().regex(/^[a-f0-9]{40}$/i) });

const searchActions = new Set(["opened", "synchronize", "reopened", "ready_for_review", "closed"]);
const pullActions = new Set([...searchActions, "converted_to_draft", "edited", "labeled", "unlabeled"]);

type ApprovalRequest =
  { kind: "commit"; input: ReviewCommitInput } | { kind: "pull_requests"; input: ReviewPullRequestsInput };

const parsePayload = (rawBody: Uint8Array): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(rawBody)) as unknown };
  } catch {
    return { ok: false };
  }
};

const parseEvent = (
  event: string,
  deliveryId: string,
  payload: unknown,
  botUserId: number
): ApprovalRequest | "invalid" | undefined => {
  const context = (value: z.output<typeof base>) => ({
    deliveryId,
    installationId: value.installation.id,
    repository: value.repository.full_name,
    repositoryId: value.repository.id,
  });

  if (event === "status") {
    const parsed = status.safeParse(payload);
    if (!parsed.success) return "invalid";

    return { kind: "commit", input: { ...context(parsed.data), sha: parsed.data.sha } };
  }

  if (event === "check_suite") {
    const parsed = suite.safeParse(payload);
    if (!parsed.success) return "invalid";

    const value = parsed.data;
    if (value.action !== "completed" || value.check_suite.pull_requests.length === 0) return undefined;

    return {
      kind: "commit",
      input: {
        ...context(value),
        sha: value.check_suite.head_sha,
        numbers: value.check_suite.pull_requests.map((pr) => pr.number),
      },
    };
  }

  if (event === "pull_request") {
    const parsed = pull.safeParse(payload);
    if (!parsed.success) return "invalid";

    const value = parsed.data;
    if (!pullActions.has(value.action)) return undefined;

    // closed の PR は評価せず、古い PR の探索だけを行う
    // 本文の編集は dispatch や Renovate の push と同時に届くため、Approve の重複を避けて Dismiss だけを行う
    return {
      kind: "pull_requests",
      input: {
        ...context(value),
        sweep: searchActions.has(value.action),
        numbers: value.action === "closed" ? [] : [value.number],
        dismissOnly: value.action === "edited",
      },
    };
  }

  if (event === "issue_comment") {
    const parsed = issue.safeParse(payload);
    if (!parsed.success) return "invalid";

    const value = parsed.data;
    if (!["created", "edited"].includes(value.action) || value.issue.pull_request === undefined) return undefined;

    return {
      kind: "pull_requests",
      input: { ...context(value), numbers: [value.issue.number], sweep: false, dismissOnly: false },
    };
  }

  if (event === "pull_request_review" || event === "pull_request_review_comment") {
    const parsed = review.safeParse(payload);
    if (!parsed.success) return "invalid";

    const value = parsed.data;

    // 自分のレビューによる Webhook の循環を防ぐ
    if (
      event === "pull_request_review" &&
      (!["submitted", "dismissed"].includes(value.action) || value.sender.id === botUserId)
    )
      return undefined;
    if (event === "pull_request_review_comment" && value.action !== "created") return undefined;

    return {
      kind: "pull_requests",
      input: { ...context(value), numbers: [value.pull_request.number], sweep: false, dismissOnly: false },
    };
  }

  return undefined;
};

export const createWebhookHandler =
  (dependencies: WebhookHandlerDependencies) =>
  async (request: Request): Promise<Response> => {
    const event = request.headers.get("x-github-event");
    const delivery = request.headers.get("x-github-delivery");
    const signature = request.headers.get("x-hub-signature-256");
    if (!event || !delivery) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
    if (!signature) return Response.json({ ok: false, code: "INVALID_SIGNATURE" }, { status: 401 });

    const rawBody = new Uint8Array(await request.arrayBuffer());
    const verified = await dependencies.verifySignature({
      rawBody,
      signatureHeader: signature,
      secret: dependencies.getWebhookSecret(),
    });
    if (!verified) {
      return Response.json({ ok: false, code: "INVALID_SIGNATURE" }, { status: 401 });
    }

    if (event === "ping") return Response.json({ ok: true });

    const payload = parsePayload(rawBody);
    if (!payload.ok) return Response.json({ ok: false, code: "INVALID_PAYLOAD" }, { status: 400 });

    const job = parseEvent(event, delivery, payload.value, dependencies.getBotUserId());
    if (job === "invalid") return Response.json({ ok: false, code: "INVALID_PAYLOAD" }, { status: 400 });
    if (!job) return Response.json({ ok: true, ignored: true });

    // 評価中の失敗は usecase が記録するので、ここでは usecase を組み立てられない設定の不備だけを扱う
    const run = async () => {
      try {
        const useCase = dependencies.createUseCase(job.input);

        if (job.kind === "commit") await useCase.reviewCommit(job.input);
        else await useCase.reviewPullRequests(job.input);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;

        dependencies.logger.log("warn", {
          event: "job_failed",
          delivery_id: job.input.deliveryId,
          installation_id: job.input.installationId,
          repository_id: job.input.repositoryId,
          reason_code: "configuration_error",
        });
      }
    };

    dependencies.waitUntil(run());

    return Response.json({ ok: true }, { status: 202 });
  };
