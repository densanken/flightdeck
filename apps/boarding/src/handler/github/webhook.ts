import { githubId } from "@flightdeck/validation";
import * as v from "valibot";

import type { BoardingMessage } from "../../message/webhook.js";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  getBotUserId: () => number;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  enqueue: (message: BoardingMessage) => Promise<void>;
  logEnqueueFailure: (deliveryId: string) => void;
}

const common = {
  repository: v.object({ full_name: v.string() }),
  installation: v.object({ id: githubId }),
};

const eventSchema = v.object(common);
const organizationSchema = v.object({
  organization: v.object({ login: v.string() }),
  installation: v.object({ id: githubId }),
  action: v.string(),
  changes: v.optional(v.record(v.string(), v.unknown())),
});
const organizationActions: Record<string, ReadonlySet<string>> = {
  membership: new Set(["added", "removed"]),
  organization: new Set(["member_added", "member_removed", "member_updated"]),
  team: new Set(["created", "deleted", "edited"]),
};
const pushSchema = v.object({ ...common, ref: v.string(), deleted: v.boolean() });
const prSchema = v.object({
  ...common,
  action: v.string(),
  number: githubId,
  pull_request: v.object({ base: v.object({ ref: v.string() }) }),
});
const reviewSchema = v.object({
  ...common,
  action: v.string(),
  pull_request: v.object({ number: githubId, base: v.object({ ref: v.string() }) }),
  review: v.object({ user: v.object({ id: githubId }) }),
});

const actions = new Set(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft", "edited"]);
const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

type MessageResult = BoardingMessage | { kind: "invalid" | "ignored" };

const toOrganizationMessage = (event: string, payload: unknown, deliveryId: string): MessageResult => {
  const parsed = v.safeParse(organizationSchema, payload);
  if (!parsed.success) return { kind: "invalid" };

  if (
    parsed.output.organization.login.toLowerCase() !== "densanken" ||
    !organizationActions[event]?.has(parsed.output.action)
  ) {
    return { kind: "ignored" };
  }

  const changes = parsed.output.changes;
  if (
    event === "team" &&
    parsed.output.action === "edited" &&
    changes !== undefined &&
    !["name", "slug", "privacy", "parent", "parent_id"].some((key) => Object.hasOwn(changes, key))
  ) {
    return { kind: "ignored" };
  }

  return { event: "permissions-changed", deliveryId, installationId: parsed.output.installation.id };
};

const toPushMessage = (payload: unknown, deliveryId: string, installationId: number): MessageResult => {
  const parsed = v.safeParse(pushSchema, payload);
  if (!parsed.success) return { kind: "invalid" };

  if (parsed.output.ref !== "refs/heads/main" || parsed.output.deleted) return { kind: "ignored" };

  return { event: "push", deliveryId, installationId };
};

const toPullRequestMessage = (payload: unknown, deliveryId: string, installationId: number): MessageResult => {
  const parsed = v.safeParse(prSchema, payload);
  if (!parsed.success) return { kind: "invalid" };

  if (!actions.has(parsed.output.action) || parsed.output.pull_request.base.ref !== "main") {
    return { kind: "ignored" };
  }

  return { event: "evaluate", deliveryId, installationId, number: parsed.output.number };
};

const toReviewMessage = (
  payload: unknown,
  deliveryId: string,
  installationId: number,
  getBotUserId: () => number
): MessageResult => {
  const parsed = v.safeParse(reviewSchema, payload);
  if (!parsed.success) return { kind: "invalid" };

  if (
    !["submitted", "dismissed"].includes(parsed.output.action) ||
    parsed.output.review.user.id === getBotUserId() ||
    parsed.output.pull_request.base.ref !== "main"
  ) {
    return { kind: "ignored" };
  }

  return { event: "evaluate", deliveryId, installationId, number: parsed.output.pull_request.number };
};

const toMessage = (event: string, payload: unknown, deliveryId: string, getBotUserId: () => number): MessageResult => {
  if (Object.hasOwn(organizationActions, event)) return toOrganizationMessage(event, payload, deliveryId);

  const commonPayload = v.safeParse(eventSchema, payload);
  if (!commonPayload.success) return { kind: "invalid" };

  if (commonPayload.output.repository.full_name.toLowerCase() !== "densanken/blog-contents") return { kind: "ignored" };

  const installationId = commonPayload.output.installation.id;
  if (event === "push") return toPushMessage(payload, deliveryId, installationId);
  if (event === "pull_request") return toPullRequestMessage(payload, deliveryId, installationId);
  return toReviewMessage(payload, deliveryId, installationId, getBotUserId);
};

export const createWebhookHandler =
  (dependencies: WebhookHandlerDependencies) =>
  async (request: Request): Promise<Response> => {
    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    const signatureHeader = request.headers.get("x-hub-signature-256");
    if (!event || !deliveryId || !signatureHeader) return json(400, { ok: false, code: "INVALID_REQUEST" });

    const rawBody = new Uint8Array(await request.arrayBuffer());
    const verified = await dependencies.verifySignature({
      rawBody,
      signatureHeader,
      secret: dependencies.getWebhookSecret(),
    });
    if (!verified) return json(401, { ok: false, code: "INVALID_SIGNATURE" });

    if (event === "ping") return json(200, { ok: true });
    if (!["push", "pull_request", "pull_request_review", "membership", "organization", "team"].includes(event)) {
      return json(200, { ok: true, ignored: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json(400, { ok: false, code: "INVALID_PAYLOAD" });
    }

    const result = toMessage(event, payload, deliveryId, dependencies.getBotUserId);

    if ("kind" in result) {
      return result.kind === "invalid"
        ? json(400, { ok: false, code: "INVALID_PAYLOAD" })
        : json(200, { ok: true, ignored: true });
    }

    try {
      await dependencies.enqueue(result);
    } catch {
      dependencies.logEnqueueFailure(deliveryId);
      return json(503, { ok: false, code: "ENQUEUE_FAILED" });
    }

    return json(202, { ok: true });
  };
