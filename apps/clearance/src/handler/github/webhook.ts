import { isAutomationBranch } from "@flightdeck/rules";
import { commitSha, githubId, repositoryFullName, ConfigurationError } from "@flightdeck/validation";
import * as v from "valibot";

import type {
  ApprovalContext,
  ApprovalUseCase,
  ReviewCommitInput,
  ReviewPullRequestsInput,
} from "../../usecase/approval/interface.js";
import type { Logger } from "@flightdeck/logger";
import type { SkipCache } from "@flightdeck/rules";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  getBotUserId: () => number;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  skipCache: SkipCache;
  createUseCase: (input: ApprovalContext) => ApprovalUseCase;
  waitUntil: (promise: Promise<void>) => void;
  logger: Logger;
}

const base = v.object({
  repository: v.object({ id: githubId, full_name: repositoryFullName }),
  installation: v.object({ id: githubId }),
  sender: v.object({ id: githubId }),
});

const action = v.object({ ...base.entries, action: v.string() });

const pull = v.object({ ...action.entries, number: githubId });

const review = v.object({ ...action.entries, pull_request: v.object({ number: githubId }) });

const issue = v.object({
  ...action.entries,
  issue: v.object({ number: githubId, pull_request: v.optional(v.unknown()) }),
});

const suite = v.object({
  ...action.entries,
  check_suite: v.object({
    head_sha: commitSha,
    head_branch: v.nullable(v.string()),
    pull_requests: v.array(v.object({ number: githubId })),
  }),
});

const status = v.object({ ...base.entries, sha: commitSha, branches: v.array(v.object({ name: v.string() })) });

const searchActions = new Set(["opened", "synchronize", "reopened", "ready_for_review", "closed"]);

const pullActions = new Set([...searchActions, "converted_to_draft", "edited", "labeled", "unlabeled"]);

type ApprovalRequest =
  // branches は、評価の対象になる branch で、すべてが見送りの期限内なら評価しない
  | { kind: "commit"; input: ReviewCommitInput; branches: string[] }
  | { kind: "pull_requests"; input: ReviewPullRequestsInput };

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
  const context = (value: v.InferOutput<typeof base>) => ({
    deliveryId,
    installationId: value.installation.id,
    repository: value.repository.full_name,
    repositoryId: value.repository.id,
  });

  if (event === "status") {
    const parsed = v.safeParse(status, payload);
    if (!parsed.success) return "invalid";

    // 対象外の branch は、認証と PR の取得をせずに見送る
    // branches が空なら、取りこぼしを避けて評価する
    const { branches, sha } = parsed.output;
    if (branches.length > 0 && !branches.some((branch) => isAutomationBranch(branch.name))) return undefined;

    return {
      kind: "commit",
      input: { ...context(parsed.output), sha },
      branches: branches.map((branch) => branch.name).filter(isAutomationBranch),
    };
  }

  if (event === "check_suite") {
    const parsed = v.safeParse(suite, payload);
    if (!parsed.success) return "invalid";

    const value = parsed.output;
    if (value.action !== "completed") return undefined;

    // 対象外の branch は、認証と PR の取得をせずに見送る
    // branch が不明なら、取りこぼしを避けて評価する
    const branch = value.check_suite.head_branch;
    if (branch !== null && !isAutomationBranch(branch)) return undefined;

    // pull_requests が空の場合は、status と同じく sha から関連 PR を引く
    const numbers = value.check_suite.pull_requests.map((pr) => pr.number);

    return {
      kind: "commit",
      input: {
        ...context(value),
        sha: value.check_suite.head_sha,
        ...(numbers.length > 0 && { numbers }),
      },
      branches: branch === null ? [] : [branch],
    };
  }

  if (event === "pull_request") {
    const parsed = v.safeParse(pull, payload);
    if (!parsed.success) return "invalid";

    const value = parsed.output;
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
    const parsed = v.safeParse(issue, payload);
    if (!parsed.success) return "invalid";

    const value = parsed.output;
    if (!["created", "edited"].includes(value.action) || value.issue.pull_request === undefined) return undefined;

    return {
      kind: "pull_requests",
      input: { ...context(value), numbers: [value.issue.number], sweep: false, dismissOnly: false },
    };
  }

  if (event === "pull_request_review" || event === "pull_request_review_comment") {
    const parsed = v.safeParse(review, payload);
    if (!parsed.success) return "invalid";

    const value = parsed.output;

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

    // 評価しても対象外のままと分かっている PR は、認証の前に見送る
    if (job.kind === "commit" && (await dependencies.skipCache.has(job.input.repositoryId, job.branches))) {
      return Response.json({ ok: true, ignored: true });
    }

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
