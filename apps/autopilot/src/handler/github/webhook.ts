import { REPOSITORY_PATTERN } from "@flightdeck/rules";
import { z } from "zod";

import { ConfigurationError } from "../../errors.js";

import type { MergeContext, MergeInput, MergeUseCase } from "../../usecase/merge/interface.js";
import type { Logger } from "@flightdeck/logger";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  createUseCase: (input: MergeContext) => MergeUseCase;
  waitUntil: (promise: Promise<void>) => void;
  logger: Logger;
}

const base = z.object({
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().regex(REPOSITORY_PATTERN) }),
  installation: z.object({ id: z.number().int().positive() }),
});
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const review = base.extend({ action: z.string(), pull_request: z.object({ number: z.number().int().positive() }) });
const suite = base.extend({
  action: z.string(),
  check_suite: z.object({ head_sha: sha, pull_requests: z.array(z.object({ number: z.number().int().positive() })) }),
});
const status = base.extend({ sha });

const parsePayload = (rawBody: Uint8Array): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(rawBody)) as unknown };
  } catch {
    return { ok: false };
  }
};

const parseEvent = (event: string, deliveryId: string, payload: unknown): MergeInput | "invalid" | undefined => {
  const context = (data: z.output<typeof base>): MergeContext => ({
    deliveryId,
    installationId: data.installation.id,
    repositoryId: data.repository.id,
    repository: data.repository.full_name,
  });

  if (event === "pull_request_review") {
    const parsed = review.safeParse(payload);
    if (!parsed.success) return "invalid";

    const data = parsed.data;
    if (data.action !== "submitted") return undefined;

    return { ...context(data), kind: "pull_request", number: data.pull_request.number };
  }

  if (event === "check_suite") {
    const parsed = suite.safeParse(payload);
    if (!parsed.success) return "invalid";

    const data = parsed.data;
    if (data.action !== "completed" || data.check_suite.pull_requests.length === 0) return undefined;

    return {
      ...context(data),
      kind: "commit",
      sha: data.check_suite.head_sha,
      numbers: data.check_suite.pull_requests.map((item) => item.number),
    };
  }

  if (event === "status") {
    const parsed = status.safeParse(payload);
    if (!parsed.success) return "invalid";

    return { ...context(parsed.data), kind: "commit", sha: parsed.data.sha };
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

    const input = parseEvent(event, deliveryId, payload.value);
    if (input === "invalid") return Response.json({ ok: false }, { status: 400 });
    if (!input) return Response.json({ ok: true, ignored: true });

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
