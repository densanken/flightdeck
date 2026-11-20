import { describe, expect, it, vi } from "vitest";

import { createWebhookHandler } from "./webhook.js";

const common = { repository: { full_name: "densanken/blog-contents" }, installation: { id: 1 } };
const pr = { ...common, action: "opened", number: 3, pull_request: { base: { ref: "main" } } };

const setup = () => {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const verifySignature = vi.fn().mockResolvedValue(true);
  const handler = createWebhookHandler({
    getWebhookSecret: () => "secret",
    getBotUserId: () => 10,
    getAppId: () => 20,
    verifySignature,
    enqueue,
    logEnqueueFailure: vi.fn(),
  });
  const send = (event: string, payload: unknown) =>
    handler(
      new Request("https://example.com/webhooks/github", {
        method: "POST",
        headers: { "x-github-event": event, "x-github-delivery": "delivery", "x-hub-signature-256": "signature" },
        body: JSON.stringify(payload),
      })
    );

  return { enqueue, verifySignature, send };
};

describe("createWebhookHandler", () => {
  it.each([
    ["requested", null, ".github/workflows/ci.yml", "pull_request", 202],
    ["completed", "action_required", ".github/workflows/ci.yml", "pull_request", 202],
    ["completed", "success", ".github/workflows/ci.yml", "pull_request", 200],
    ["completed", "failure", ".github/workflows/ci.yml", "pull_request", 200],
    ["completed", null, ".github/workflows/ci.yml", "pull_request", 200],
    ["in_progress", "action_required", ".github/workflows/ci.yml", "pull_request", 200],
    ["requested", null, ".github/workflows/ci.yml@refs/pull/1/merge", "pull_request", 202],
    ["requested", null, ".github/workflows/other.yml@refs/pull/1/merge", "pull_request", 200],
    ["requested", null, ".github/workflows/other.yml", "pull_request", 200],
    ["requested", null, ".github/workflows/ci.yml", "push", 200],
    ["completed", "action_required", ".github/workflows/other.yml", "pull_request", 200],
    ["completed", "action_required", ".github/workflows/ci.yml", "push", 200],
  ])("Workflow Run のイベントを選別する: %s %s %s %s", async (action, conclusion, path, event, status) => {
    const { send, enqueue } = setup();
    const sha = "a".repeat(40);
    const response = await send("workflow_run", {
      ...common,
      repository: { ...common.repository, id: 99 },
      action,
      workflow_run: { path, event, conclusion, head_sha: sha, head_repository: { id: 100 }, pull_requests: [] },
    });
    expect(response.status).toBe(status);
    if (status === 202) {
      expect(enqueue).toHaveBeenCalledWith({
        event: "ci-requested",
        deliveryId: "delivery",
        installationId: 1,
        repositoryId: 99,
        sha,
      });
    } else {
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it.each([
    [99, 200],
    [100, 202],
    [null, 202],
  ] as const)("head repository %s の Workflow Run を判定する", async (id, status) => {
    const { send, enqueue } = setup();
    const response = await send("workflow_run", {
      ...common,
      repository: { ...common.repository, id: 99 },
      action: "requested",
      workflow_run: {
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        conclusion: null,
        head_sha: "a".repeat(40),
        head_repository: id === null ? null : { id },
      },
    });
    expect(response.status).toBe(status);
    expect(enqueue).toHaveBeenCalledTimes(status === 202 ? 1 : 0);
  });

  it.each(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft", "edited"])(
    "対象の PR イベントを Queue に投入する: %s",
    async (action) => {
      const { send, enqueue } = setup();
      expect((await send("pull_request", { ...pr, action })).status).toBe(202);
      expect(enqueue).toHaveBeenCalledWith({
        event: "evaluate",
        deliveryId: "delivery",
        installationId: 1,
        number: 3,
        opened: action === "opened",
      });
    }
  );

  it.each([true, false])("closed を Merge 済みかどうかとともに Queue に投入する: %s", async (merged) => {
    const { send, enqueue } = setup();
    const response = await send("pull_request", {
      ...pr,
      action: "closed",
      pull_request: { ...pr.pull_request, merged },
    });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      event: "closed",
      deliveryId: "delivery",
      installationId: 1,
      number: 3,
      merged,
    });
  });

  it("main 以外への edited を無視する", async () => {
    const { send, enqueue } = setup();
    expect(
      (await send("pull_request", { ...pr, action: "edited", pull_request: { base: { ref: "other" } } })).status
    ).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([{ pullRequests: [] }, { pullRequests: [{ number: 3 }] }])(
    "Check Suite の PR 一覧 $pullRequests によらず SHA を投入する",
    async ({ pullRequests }) => {
      const { send, enqueue } = setup();
      const sha = "a".repeat(40);
      const repository = { ...common.repository, id: 99 };
      expect(
        (
          await send("check_suite", {
            ...common,
            repository,
            action: "completed",
            check_suite: { head_sha: sha, app: { id: 21 }, pull_requests: pullRequests },
          })
        ).status
      ).toBe(202);
      expect(enqueue).toHaveBeenCalledWith({
        event: "ci-completed",
        deliveryId: "delivery",
        installationId: 1,
        repositoryId: 99,
        sha,
      });
    }
  );

  it("自分の Check Suite を無視する", async () => {
    const { send, enqueue } = setup();
    const repository = { ...common.repository, id: 99 };
    expect(
      (
        await send("check_suite", {
          ...common,
          repository,
          action: "completed",
          check_suite: { head_sha: "a".repeat(40), app: { id: 20 }, pull_requests: [] },
        })
      ).status
    ).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["success", "failure", "error"])("%s の Status を SHA とともに投入する", async (state) => {
    const { send, enqueue } = setup();
    const sha = "b".repeat(40);
    expect((await send("status", { ...common, repository: { ...common.repository, id: 99 }, sha, state })).status).toBe(
      202
    );
    expect(enqueue).toHaveBeenCalledWith({
      event: "ci-completed",
      deliveryId: "delivery",
      installationId: 1,
      repositoryId: 99,
      sha,
    });
  });

  it("pending の Status を無視する", async () => {
    const { send, enqueue } = setup();
    const payload = { ...common, repository: { ...common.repository, id: 99 }, sha: "b".repeat(40), state: "pending" };
    expect((await send("status", payload)).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("署名が不正なら投入しない", async () => {
    const { send, enqueue, verifySignature } = setup();
    verifySignature.mockResolvedValue(false);
    expect((await send("pull_request", pr)).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("対象外のリポジトリは無視する", async () => {
    const { send, enqueue } = setup();
    expect((await send("pull_request", { ...pr, repository: { full_name: "other/repo" } })).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("main への push を投入する", async () => {
    const { send, enqueue } = setup();
    expect((await send("push", { ...common, ref: "refs/heads/main", deleted: false })).status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({ event: "push", deliveryId: "delivery", installationId: 1 });
  });

  it("自分自身の Review を無視する", async () => {
    const { send, enqueue } = setup();
    const payload = {
      ...common,
      action: "submitted",
      pull_request: { number: 3, base: { ref: "main" } },
      review: { user: { id: 10 } },
    };
    expect((await send("pull_request_review", payload)).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("他人の dismissed Review を投入する", async () => {
    const { send, enqueue } = setup();
    const payload = {
      ...common,
      action: "dismissed",
      pull_request: { number: 3, base: { ref: "main" } },
      review: { user: { id: 11 } },
    };
    expect((await send("pull_request_review", payload)).status).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    ["membership", "added"],
    ["membership", "removed"],
    ["organization", "member_added"],
    ["organization", "member_removed"],
    ["organization", "member_updated"],
    ["team", "created"],
    ["team", "deleted"],
    ["team", "edited"],
  ])("Org の権限変更を再評価に投入する: %s / %s", async (event, action) => {
    const { send, enqueue } = setup();
    expect((await send(event, { action, organization: { login: "densanken" }, installation: { id: 1 } })).status).toBe(
      202
    );
    expect(enqueue).toHaveBeenCalledWith({ event: "permissions-changed", deliveryId: "delivery", installationId: 1 });
  });

  it.each([
    ["membership", "other"],
    ["organization", "member_invited"],
    ["team", "added_to_repository"],
  ])("権限に影響しない action を無視する: %s / %s", async (event, action) => {
    const { send, enqueue } = setup();
    expect((await send(event, { action, organization: { login: "densanken" }, installation: { id: 1 } })).status).toBe(
      200
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("Team の説明だけの変更を無視する", async () => {
    const { send, enqueue } = setup();
    expect(
      (
        await send("team", {
          action: "edited",
          organization: { login: "densanken" },
          installation: { id: 1 },
          changes: { description: { from: "old" } },
        })
      ).status
    ).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("他の Org や不正な Installation を受け付けない", async () => {
    const { send, enqueue } = setup();
    expect(
      (await send("membership", { action: "removed", organization: { login: "other" }, installation: { id: 1 } }))
        .status
    ).toBe(200);
    expect(
      (await send("membership", { action: "removed", organization: { login: "densanken" }, installation: { id: 0 } }))
        .status
    ).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("Queue 投入の失敗を通知する", async () => {
    const { send, enqueue } = setup();
    enqueue.mockRejectedValue(new Error("failed"));
    expect((await send("pull_request", pr)).status).toBe(503);
  });
});
