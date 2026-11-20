import { githubId } from "@flightdeck/validation";
import * as v from "valibot";

import { isCiWorkflowPath } from "../../domain/workflow.js";

import type { BoardingMessage } from "../../message/webhook.js";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  getBotUserId: () => number;
  getAppId: () => number;
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
const sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));
const suiteSchema = v.object({
  ...common,
  repository: v.object({ full_name: v.string(), id: githubId }),
  action: v.string(),
  check_suite: v.object({
    head_sha: sha,
    app: v.object({ id: githubId }),
  }),
});
const workflowSchema = v.object({
  ...common,
  repository: v.object({ full_name: v.string(), id: githubId }),
  action: v.string(),
  workflow_run: v.object({
    path: v.string(),
    event: v.string(),
    head_sha: sha,
    conclusion: v.optional(v.nullable(v.string())),
    head_repository: v.nullable(v.object({ id: githubId })),
  }),
});
const statusSchema = v.object({
  ...common,
  repository: v.object({ full_name: v.string(), id: githubId }),
  sha,
  state: v.picklist(["pending", "success", "failure", "error"]),
});
const prSchema = v.object({
  ...common,
  action: v.string(),
  number: githubId,
  pull_request: v.object({ base: v.object({ ref: v.string() }), merged: v.optional(v.nullable(v.boolean())) }),
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

  if (parsed.output.pull_request.base.ref !== "main") return { kind: "ignored" };
  if (parsed.output.action === "closed") {
    return {
      event: "closed",
      deliveryId,
      installationId,
      number: parsed.output.number,
      merged: parsed.output.pull_request.merged === true,
    };
  }

  if (!actions.has(parsed.output.action)) {
    return { kind: "ignored" };
  }

  return {
    event: "evaluate",
    deliveryId,
    installationId,
    number: parsed.output.number,
    opened: parsed.output.action === "opened",
  };
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

const toSuiteMessage = (
  payload: unknown,
  deliveryId: string,
  installationId: number,
  getAppId: () => number
): MessageResult => {
  const parsed = v.safeParse(suiteSchema, payload);
  if (!parsed.success) return { kind: "invalid" };

  const data = parsed.output;
  if (data.action !== "completed" || data.check_suite.app.id === getAppId()) return { kind: "ignored" };

  return {
    event: "ci-completed",
    deliveryId,
    installationId,
    repositoryId: data.repository.id,
    sha: data.check_suite.head_sha,
  };
};

const toWorkflowMessage = (payload: unknown, deliveryId: string, installationId: number): MessageResult => {
  const parsed = v.safeParse(workflowSchema, payload);
  if (!parsed.success) return { kind: "invalid" };

  const data = parsed.output;
  if (
    (data.action !== "requested" &&
      !(data.action === "completed" && data.workflow_run.conclusion === "action_required")) ||
    !isCiWorkflowPath(data.workflow_run.path) ||
    data.workflow_run.event !== "pull_request" ||
    data.workflow_run.head_repository?.id === data.repository.id
  ) {
    return { kind: "ignored" };
  }

  return {
    event: "ci-requested",
    deliveryId,
    installationId,
    repositoryId: data.repository.id,
    sha: data.workflow_run.head_sha,
  };
};

const toStatusMessage = (payload: unknown, deliveryId: string, installationId: number): MessageResult => {
  const parsed = v.safeParse(statusSchema, payload);
  if (!parsed.success) return { kind: "invalid" };
  if (parsed.output.state === "pending") return { kind: "ignored" };

  return {
    event: "ci-completed",
    deliveryId,
    installationId,
    repositoryId: parsed.output.repository.id,
    sha: parsed.output.sha,
  };
};

const toMessage = (
  event: string,
  payload: unknown,
  deliveryId: string,
  getBotUserId: () => number,
  getAppId: () => number
): MessageResult => {
  if (Object.hasOwn(organizationActions, event)) return toOrganizationMessage(event, payload, deliveryId);

  const commonPayload = v.safeParse(eventSchema, payload);
  if (!commonPayload.success) return { kind: "invalid" };

  if (commonPayload.output.repository.full_name.toLowerCase() !== "densanken/blog-contents") return { kind: "ignored" };

  const installationId = commonPayload.output.installation.id;
  if (event === "push") return toPushMessage(payload, deliveryId, installationId);
  if (event === "check_suite") return toSuiteMessage(payload, deliveryId, installationId, getAppId);
  if (event === "workflow_run") return toWorkflowMessage(payload, deliveryId, installationId);
  if (event === "status") return toStatusMessage(payload, deliveryId, installationId);
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
    if (
      ![
        "push",
        "pull_request",
        "pull_request_review",
        "check_suite",
        "status",
        "workflow_run",
        "membership",
        "organization",
        "team",
      ].includes(event)
    ) {
      return json(200, { ok: true, ignored: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json(400, { ok: false, code: "INVALID_PAYLOAD" });
    }

    const result = toMessage(event, payload, deliveryId, dependencies.getBotUserId, dependencies.getAppId);

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
