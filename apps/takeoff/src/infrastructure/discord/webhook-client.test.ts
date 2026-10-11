import { describe, it, expect, vi, beforeEach } from "vitest";

import { notifyMergeAudit } from "./webhook-client";

import type { MergeAuditPayload } from "../../usecase/merge/interface.js";

interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

interface WebhookBody {
  embeds: {
    title: string;
    fields: EmbedField[];
  }[];
  allowed_mentions: { parse: string[] };
}

const samplePayload: MergeAuditPayload = {
  discordUserId: "user456",
  repo: {
    repoId: "789",
    fullName: "org/repo",
    htmlUrl: "https://github.com/org/repo",
  },
  pullRequest: {
    number: 42,
    title: "fix: webhook retry handling",
    htmlUrl: "https://github.com/org/repo/pull/42",
    headRef: "feature/example",
    baseRef: "main",
    headSha: "abcdef123456789012345678901234567890",
  },
  merge: {
    method: "squash",
    commitSha: "123456abcdef789012345678901234567890",
    mergedAt: new Date("2026-06-17T12:30:00Z"),
  },
};

describe("notifyMergeAudit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("webhook に embed 形式で POST する", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await notifyMergeAudit("https://discord.com/api/webhooks/test", samplePayload);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls.at(0);
    const [url, init] = call ?? [];
    expect(url).toBe("https://discord.com/api/webhooks/test");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body as string) as WebhookBody;
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds.at(0)?.title).toBe("PR をマージしました");
  });

  it("allowed_mentions で mention を無効化する", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await notifyMergeAudit("https://discord.com/api/webhooks/test", {
      ...samplePayload,
      pullRequest: { ...samplePayload.pullRequest, title: "@everyone を含む title" },
    });

    const body = JSON.parse(fetchSpy.mock.calls.at(0)?.[1]?.body as string) as WebhookBody;
    expect(body.allowed_mentions.parse).toEqual([]);
  });

  it("PR title の markdown link 記法を escape する", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await notifyMergeAudit("https://discord.com/api/webhooks/test", {
      ...samplePayload,
      pullRequest: { ...samplePayload.pullRequest, title: "fix: x](https://evil.example)[" },
    });

    const body = JSON.parse(fetchSpy.mock.calls.at(0)?.[1]?.body as string) as WebhookBody;
    const fields = body.embeds.at(0)?.fields ?? [];
    const prField = fields.find((field) => field.name === "PR");
    expect(prField?.value).toContain("x\\](https://evil.example)\\[");
  });

  it("branch 名を inline code にし、` は置き換える", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await notifyMergeAudit("https://discord.com/api/webhooks/test", {
      ...samplePayload,
      pullRequest: { ...samplePayload.pullRequest, headRef: "feature/`x`", baseRef: "main" },
    });

    const body = JSON.parse(fetchSpy.mock.calls.at(0)?.[1]?.body as string) as WebhookBody;
    const fields = body.embeds.at(0)?.fields ?? [];
    const branchField = fields.find((field) => field.name === "Branch");
    expect(branchField?.value).toBe("`feature/'x'` → `main`");
  });

  it("Merged by を Discord の user mention、Merged at を Discord の timestamp 記法にする", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await notifyMergeAudit("https://discord.com/api/webhooks/test", samplePayload);

    const body = JSON.parse(fetchSpy.mock.calls.at(0)?.[1]?.body as string) as WebhookBody;
    const fields = body.embeds.at(0)?.fields ?? [];
    expect(fields.find((field) => field.name === "Merged by")?.value).toBe("<@user456>");
    expect(fields.find((field) => field.name === "Merged at")?.value).toBe("<t:1781699400:F>");
  });

  it("SHA を 7 文字の inline code にする", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    await notifyMergeAudit("https://discord.com/api/webhooks/test", samplePayload);

    const body = JSON.parse(fetchSpy.mock.calls.at(0)?.[1]?.body as string) as WebhookBody;
    const fields = body.embeds.at(0)?.fields ?? [];
    const headShaField = fields.find((f) => f.name === "Head SHA");
    const mergeShaField = fields.find((f) => f.name === "Merge commit");
    expect(headShaField?.value).toBe("`abcdef1`");
    expect(mergeShaField?.value).toBe("`123456a`");
  });

  it("webhook の送信失敗時に error を log へ出力する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });

    await notifyMergeAudit("https://discord.com/api/webhooks/test", samplePayload);

    expect(consoleErrorSpy).toHaveBeenCalledWith("merge_audit_webhook_http_error", { status: 500 });
  });
});
