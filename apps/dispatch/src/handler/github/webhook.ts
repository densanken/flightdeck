import { sourceOf } from "@flightdeck/rules";
import { commitSha, githubId, repositoryFullName, splitRepository } from "@flightdeck/validation";
import * as v from "valibot";

import { isManagedBranch } from "../../domain/naming.js";

import type { DispatchMessage } from "../../message/webhook.js";
import type { Logger } from "../../util/logger.js";

export interface WebhookHandlerDependencies {
  getWebhookSecret: () => string;
  verifySignature: (input: { rawBody: Uint8Array; signatureHeader: string; secret: string }) => Promise<boolean>;
  enqueue: (message: DispatchMessage) => Promise<void>;
  logger: Logger;
}

const BRANCH_REF_PREFIX = "refs/heads/";

// branch を新しく作った push の before
const ZERO_OID = /^0+$/;

// どの event も、event の repository と、Webhook が署名つきで運ぶ Installation の ID を持つ
const eventSchema = v.object({
  repository: v.object({ full_name: repositoryFullName }),
  installation: v.object({ id: githubId }),
});

const pushSchema = v.object({ ...eventSchema.entries, ref: v.string(), before: commitSha, deleted: v.boolean() });

const repositoryEditedSchema = v.object({
  ...eventSchema.entries,
  action: v.string(),
  changes: v.optional(v.object({ default_branch: v.optional(v.object({ from: v.string() })) })),
});

// head と base の repo は、fork から開いた PR を除くために比べる
// fork が削除されていれば head.repo は null
const pullRequestSchema = v.object({
  ...eventSchema.entries,
  action: v.string(),
  changes: v.optional(v.object({ base: v.optional(v.unknown()) })),
  pull_request: v.object({
    head: v.object({ ref: v.string(), repo: v.nullable(v.object({ id: githubId })) }),
    base: v.object({ repo: v.object({ id: githubId }) }),
  }),
});

const installationOf = ({ repository, installation }: v.InferOutput<typeof eventSchema>) => ({
  owner: splitRepository(repository.full_name).owner,
  id: installation.id,
});

// 管理 branch 名から source を戻し、event の repository（parent）の target を同期する子 message にする
// 管理 branch 名から source を戻せなければ undefined
const syncTargetOf = (
  deliveryId: string,
  branch: string,
  payload: v.InferOutput<typeof eventSchema>
): DispatchMessage | undefined => {
  const source = sourceOf(branch);
  if (!source) return undefined;

  return {
    event: "sync-target",
    deliveryId,
    installation: installationOf(payload),
    source,
    target: payload.repository.full_name,
  };
};

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

// 同期が不要な event は enqueue せず undefined を返す
const toMessage = (event: string, deliveryId: string, payload: unknown): DispatchMessage | undefined | "invalid" => {
  if (event === "push") {
    const push = v.safeParse(pushSchema, payload);
    if (!push.success) return "invalid";

    const { ref, before, deleted } = push.output;
    if (deleted || !ref.startsWith(BRANCH_REF_PREFIX)) return undefined;

    const branch = ref.slice(BRANCH_REF_PREFIX.length);

    // 管理 branch への手動 commit は、source や base の push を待たずにその target を同期して上書きする
    // 自身の push でも同期するが、その間に base か source が進んでいなければ branch を書き換えずに終わる
    // 進んでいても 1 回の書き換えで収まり、循環しない
    if (isManagedBranch(branch)) return syncTargetOf(deliveryId, branch, push.output);

    return {
      event: "push",
      deliveryId,
      installation: installationOf(push.output),
      repository: push.output.repository.full_name,
      branch,
      ...(ZERO_OID.test(before) ? {} : { before }),
    };
  }

  if (event === "repository") {
    const edited = v.safeParse(repositoryEditedSchema, payload);
    if (!edited.success) return "invalid";

    const previous = edited.output.changes?.default_branch?.from;
    if (edited.output.action !== "edited" || previous === undefined) return undefined;

    return {
      event: "default-branch-changed",
      deliveryId,
      installation: installationOf(edited.output),
      repository: edited.output.repository.full_name,
      previousDefaultBranch: previous,
    };
  }

  if (event === "pull_request") {
    const parsed = v.safeParse(pullRequestSchema, payload);
    if (!parsed.success) return "invalid";

    const { action, changes, pull_request: pullRequest } = parsed.output;
    // 管理 branch の PR が開かれたか base が変わったら、次の push を待たずにその target を同期する（重複 PR の Close や base の修正も含む）
    const relevant =
      action === "opened" || action === "reopened" || (action === "edited" && changes?.base !== undefined);
    if (!relevant || pullRequest.head.repo?.id !== pullRequest.base.repo.id) return undefined;

    return syncTargetOf(deliveryId, pullRequest.head.ref, parsed.output);
  }

  return undefined;
};

export const createWebhookHandler =
  (dependencies: WebhookHandlerDependencies) =>
  async (request: Request): Promise<Response> => {
    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    const signatureHeader = request.headers.get("x-hub-signature-256");
    if (!event || !deliveryId || !signatureHeader) return json(400, { ok: false, code: "INVALID_REQUEST" });

    // 署名は decode 前の raw byte 列で検証し、検証が通るまで body を解釈しない
    const rawBody = new Uint8Array(await request.arrayBuffer());
    const verified = await dependencies.verifySignature({
      rawBody,
      signatureHeader,
      secret: dependencies.getWebhookSecret(),
    });
    if (!verified) return json(401, { ok: false, code: "INVALID_SIGNATURE" });

    if (event === "ping") return json(200, { ok: true });

    let payload: unknown;

    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json(400, { ok: false, code: "INVALID_PAYLOAD" });
    }

    const message = toMessage(event, deliveryId, payload);
    if (message === "invalid") return json(400, { ok: false, code: "INVALID_PAYLOAD" });
    if (!message) return json(200, { ok: true, ignored: true });

    try {
      await dependencies.enqueue(message);
    } catch {
      // 本文は記録せず、再配信を依頼できるよう 5xx で返す
      dependencies.logger.log("error", { event: "enqueue_failed", githubEvent: event, deliveryId });

      return json(503, { ok: false, code: "ENQUEUE_FAILED" });
    }

    return json(202, { ok: true });
  };
