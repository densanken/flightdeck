import { commitSha, githubId, repositoryFullName, ConfigurationError } from "@flightdeck/validation";
import * as v from "valibot";

import type { MergeContext, MergeInput, MergeUseCase } from "../../usecase/merge/interface.js";
import type { Logger } from "@flightdeck/logger";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  createUseCase: (input: MergeContext) => MergeUseCase;
  waitUntil: (promise: Promise<void>) => void;
  logger: Logger;
}

const base = v.object({
  repository: v.object({ id: githubId, full_name: repositoryFullName }),
  installation: v.object({ id: githubId }),
});

const review = v.object({ ...base.entries, action: v.string(), pull_request: v.object({ number: githubId }) });

const suite = v.object({
  ...base.entries,
  action: v.string(),
  check_suite: v.object({ head_sha: commitSha, pull_requests: v.array(v.object({ number: githubId })) }),
});

const status = v.object({ ...base.entries, sha: commitSha });

const parsePayload = (rawBody: Uint8Array): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(rawBody)) as unknown };
  } catch {
    return { ok: false };
  }
};

const parseEvent = (event: string, deliveryId: string, payload: unknown): MergeInput | "invalid" | undefined => {
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
    if (data.action !== "submitted") return undefined;

    return { ...context(data), kind: "pull_request", number: data.pull_request.number };
  }

  if (event === "check_suite") {
    const parsed = v.safeParse(suite, payload);
    if (!parsed.success) return "invalid";

    const data = parsed.output;
    if (data.action !== "completed") return undefined;

    // pull_requests が空の場合は、status と同じく sha から関連 PR を引く
    const numbers = data.check_suite.pull_requests.map((item) => item.number);

    return {
      ...context(data),
      kind: "commit",
      sha: data.check_suite.head_sha,
      ...(numbers.length > 0 && { numbers }),
    };
  }

  if (event === "status") {
    const parsed = v.safeParse(status, payload);
    if (!parsed.success) return "invalid";

    return { ...context(parsed.output), kind: "commit", sha: parsed.output.sha };
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
