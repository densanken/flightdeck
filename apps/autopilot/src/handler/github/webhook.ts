import { isAutomationBranch } from "@flightdeck/rules";
import { commitSha, githubId, repositoryFullName, ConfigurationError } from "@flightdeck/validation";
import * as v from "valibot";

import type { MergeContext, MergeInput, MergeUseCase } from "../../usecase/merge/interface.js";
import type { Logger } from "@flightdeck/logger";
import type { SkipCache } from "@flightdeck/rules";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  skipCache: SkipCache;
  createUseCase: (input: MergeContext) => MergeUseCase;
  waitUntil: (promise: Promise<void>) => void;
  logger: Logger;
}

const base = v.object({
  repository: v.object({ id: githubId, full_name: repositoryFullName }),
  installation: v.object({ id: githubId }),
});

const review = v.object({
  ...base.entries,
  action: v.string(),
  pull_request: v.object({ number: githubId, head: v.object({ ref: v.string() }) }),
});

const suite = v.object({
  ...base.entries,
  action: v.string(),
  check_suite: v.object({
    head_sha: commitSha,
    head_branch: v.nullable(v.string()),
    pull_requests: v.array(v.object({ number: githubId })),
  }),
});

const status = v.object({ ...base.entries, sha: commitSha, branches: v.array(v.object({ name: v.string() })) });

const parsePayload = (rawBody: Uint8Array): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(rawBody)) as unknown };
  } catch {
    return { ok: false };
  }
};

interface ParsedEvent {
  input: MergeInput;
  // 評価の対象になる branch
  // すべてが見送りの期限内なら、評価しない
  branches: string[];
}

const parseEvent = (event: string, deliveryId: string, payload: unknown): ParsedEvent | "invalid" | undefined => {
  const context = (data: v.InferOutput<typeof base>): MergeContext => ({
    deliveryId,
    installationId: data.installation.id,
    repositoryId: data.repository.id,
    repository: data.repository.full_name,
  });

  if (event === "pull_request_review") {
    const parsed = v.safeParse(review, payload);
    if (!parsed.success) return "invalid";

    const data = parsed.output;
    if (data.action !== "submitted" || !isAutomationBranch(data.pull_request.head.ref)) return undefined;

    return {
      input: { ...context(data), kind: "pull_request", number: data.pull_request.number },
      // clearance の Approve を契機にするため、見送りの期限内でも評価する
      branches: [],
    };
  }

  if (event === "check_suite") {
    const parsed = v.safeParse(suite, payload);
    if (!parsed.success) return "invalid";

    const data = parsed.output;
    if (data.action !== "completed") return undefined;

    // 対象外の branch は、認証と PR の取得をせずに見送る
    // branch が不明なら、取りこぼしを避けて評価する
    const branch = data.check_suite.head_branch;
    if (branch !== null && !isAutomationBranch(branch)) return undefined;

    // pull_requests が空の場合は、status と同じく sha から関連 PR を引く
    const numbers = data.check_suite.pull_requests.map((item) => item.number);

    return {
      input: {
        ...context(data),
        kind: "commit",
        sha: data.check_suite.head_sha,
        ...(numbers.length > 0 && { numbers }),
      },
      branches: branch === null ? [] : [branch],
    };
  }

  if (event === "status") {
    const parsed = v.safeParse(status, payload);
    if (!parsed.success) return "invalid";

    // branches が空なら、取りこぼしを避けて評価する
    const { branches, sha } = parsed.output;
    if (branches.length > 0 && !branches.some((branch) => isAutomationBranch(branch.name))) return undefined;

    return {
      input: { ...context(parsed.output), kind: "commit", sha },
      branches: branches.map((item) => item.name).filter(isAutomationBranch),
    };
  }

  return undefined;
};

export const createWebhookHandler =
  (dependencies: WebhookHandlerDependencies) =>
  async (request: Request): Promise<Response> => {
    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    const signatureHeader = request.headers.get("x-hub-signature-256");
    if (!event || !deliveryId) return Response.json({ ok: false }, { status: 400 });
    if (!signatureHeader) return Response.json({ ok: false }, { status: 401 });

    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (!(await dependencies.verifySignature({ rawBody, signatureHeader, secret: dependencies.getWebhookSecret() }))) {
      return Response.json({ ok: false }, { status: 401 });
    }

    if (!["pull_request_review", "check_suite", "status"].includes(event)) {
      return Response.json({ ok: true, ignored: true });
    }

    const payload = parsePayload(rawBody);
    if (!payload.ok) return Response.json({ ok: false }, { status: 400 });

    const parsed = parseEvent(event, deliveryId, payload.value);
    if (parsed === "invalid") return Response.json({ ok: false }, { status: 400 });
    if (!parsed) return Response.json({ ok: true, ignored: true });

    // 評価しても対象外のままと分かっている PR は、認証の前に見送る
    const { input, branches } = parsed;
    if (await dependencies.skipCache.has(input.repositoryId, branches)) {
      return Response.json({ ok: true, ignored: true });
    }

    const run = async () => {
      try {
        const useCase = dependencies.createUseCase(input);
        await useCase.execute(input);
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;

        dependencies.logger.log("warn", {
          event: "job_failed",
          delivery_id: input.deliveryId,
          installation_id: input.installationId,
          repository_id: input.repositoryId,
          reason_code: "configuration_error",
        });
      }
    };

    dependencies.waitUntil(run());
    return Response.json({ ok: true }, { status: 202 });
  };
