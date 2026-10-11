import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { gitHubRepositoryEventSchema, gitHubWorkflowRunEventSchema } from "./payload.js";

import type { Env } from "../../env.js";
import type { AutoApproveUsecase } from "../../usecase/auto-approve/interface.js";
import type { RepositoryAdminUsecase } from "../../usecase/repository-admin/interface.js";
import type { Context } from "hono";

export interface GitHubWebhookDependencies {
  autoApproveUsecase: AutoApproveUsecase;
  repositoryAdminUsecase: RepositoryAdminUsecase;
}

export interface GitHubWebhookRouteDependencies {
  createDependencies(env: Env["Bindings"]): GitHubWebhookDependencies;
  verifySignature(secret: string, signature: string, body: Uint8Array): Promise<boolean>;
}

const ok = (c: Context<Env>) => c.json({ ok: true }, 200);

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const handleWorkflowRunEvent = (c: Context<Env>, deps: GitHubWebhookDependencies, json: unknown): Response => {
  const parsed = gitHubWorkflowRunEventSchema.safeParse(json);
  if (!parsed.success) {
    // ZodError は payload 由来の値を含むため、安定した event 名と issue 数だけを記録する
    console.error("github_webhook_payload_invalid", {
      event: "workflow_run",
      issueCount: parsed.error.issues.length,
    });
    return ok(c);
  }

  const payload = parsed.data;

  if (payload.action !== "requested" || payload.workflow_run.event !== "pull_request") {
    return ok(c);
  }

  const headRepository = payload.workflow_run.head_repository;
  if (!headRepository) {
    return ok(c);
  }
  if (headRepository.full_name === payload.repository.full_name) {
    return ok(c);
  }

  c.executionCtx.waitUntil(
    deps.autoApproveUsecase
      .autoApproveByRunId({
        repoId: String(payload.repository.id),
        // KV の登録情報ではなく payload の座標を使う（rename 直後でも最新の owner/name で呼べる）
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        runId: payload.workflow_run.id,
        actorLogin: payload.workflow_run.actor.login,
      })
      .then(
        (result) => {
          if (result.type === "not_registered") return;
          console.log(
            `auto-approve: run=${String(payload.workflow_run.id)} actor=${payload.workflow_run.actor.login} approved=${String(result.approved)} reason=${result.reason}`
          );
        },
        (error: unknown) => {
          // auto-approve 経路の error は GitHub API 由来で message の安全性を保証できないため、
          // message は記録せず error の name だけを記録する
          console.error("github_webhook_auto_approve_failed", {
            repositoryId: String(payload.repository.id),
            runId: payload.workflow_run.id,
            errorName: errorNameOf(error),
          });
        }
      )
  );
  return ok(c);
};

const handleRepositoryEvent = (
  c: Context<Env>,
  deps: GitHubWebhookDependencies,
  json: unknown,
  deliveryId: string
): Response => {
  const parsed = gitHubRepositoryEventSchema.safeParse(json);
  if (!parsed.success) {
    // ZodError は payload 由来の値を含むため、安定した event 名と issue 数だけを記録する
    console.error("github_webhook_payload_invalid", { event: "repository", issueCount: parsed.error.issues.length });
    return ok(c);
  }

  const payload = parsed.data;
  if (payload.action !== "renamed" && payload.action !== "transferred") {
    return ok(c);
  }

  const repositoryId = String(payload.repository.id);
  c.executionCtx.waitUntil(
    deps.repositoryAdminUsecase.reconcileRepository(repositoryId, c.env.GITHUB_ORG).then(
      (result) => {
        console.log("github_repository_reconciled", { deliveryId, repositoryId, outcome: result.type });
      },
      (error: unknown) => {
        console.error("github_repository_reconcile_failed", {
          deliveryId,
          repositoryId,
          errorName: errorNameOf(error),
        });
      }
    )
  );
  return ok(c);
};

export const createGitHubWebhookRoute = (dependencies: GitHubWebhookRouteDependencies) => {
  const github = new Hono<Env>();

  github.use("/github", bodyLimit({ maxSize: 256 * 1024 }));

  github.post("/github", async (c) => {
    const secret = c.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return c.json({ error: "webhook secret not configured" }, 401);
    }

    const signature = c.req.header("X-Hub-Signature-256");
    if (!signature) return c.json({ error: "missing signature" }, 401);
    const event = c.req.header("X-GitHub-Event");
    if (!event) return c.json({ error: "missing event" }, 400);
    const deliveryId = c.req.header("X-GitHub-Delivery");
    if (!deliveryId) return c.json({ error: "missing delivery" }, 400);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(deliveryId)) return c.json({ error: "invalid delivery" }, 400);
    const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return c.json({ error: "unsupported content type" }, 415);

    // 署名検証までの想定外の失敗は、Hono 既定の error handler へ渡さず固定の 500 で返す
    // 署名検証前の payload と event 名は信用できないため、記録するのは形式検証済みの delivery ID と段階、error の name に限る
    const receiveFailed = (stage: "body_read" | "signature_verification", error: unknown) => {
      console.error("github_webhook_receive_failed", { deliveryId, stage, errorName: errorNameOf(error) });
      return c.json({ error: "internal error" }, 500);
    };

    let body: Uint8Array;
    try {
      body = new Uint8Array(await c.req.arrayBuffer());
    } catch (error) {
      return receiveFailed("body_read", error);
    }

    let valid: boolean;
    try {
      valid = await dependencies.verifySignature(secret, signature, body);
    } catch (error) {
      return receiveFailed("signature_verification", error);
    }
    if (!valid) {
      return c.json({ error: "invalid signature" }, 401);
    }

    if (event !== "workflow_run" && event !== "repository") {
      return ok(c);
    }

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    // GitHub の Webhook 応答期限は 10 秒のため、event の処理は応答後の waitUntil で行う
    // 処理の失敗は応答に反映されないため、記録だけを残す
    const deps = dependencies.createDependencies(c.env);
    if (event === "repository") {
      return handleRepositoryEvent(c, deps, json, deliveryId);
    }
    return handleWorkflowRunEvent(c, deps, json);
  });

  return github;
};
