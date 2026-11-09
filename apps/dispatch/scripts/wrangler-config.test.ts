import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("wrangler config", () => {
  it("workers.dev と preview URL を無効にし、公開 route を Dashboard 管理に保つ", () => {
    expect(config).toMatch(/"workers_dev"\s*:\s*false/);
    expect(config).toMatch(/"preview_urls"\s*:\s*false/);
    expect(config).not.toMatch(/"routes?"\s*:/);
  });

  it("Cron、KV、D1、R2、Durable Objects を使わない", () => {
    expect(config).not.toMatch(/"(crons?|kv_namespaces|d1_databases|r2_buckets|durable_objects)"\s*:/);
  });

  it("Queue の consumer は 1 件ずつ直列に処理し、retry 後に破棄する", () => {
    expect(config).toMatch(/"binding"\s*:\s*"GITHUB_WEBHOOK_QUEUE"/);
    expect(config).toMatch(/"queue"\s*:\s*"dispatch-github-webhooks"/);
    expect(config).toMatch(/"max_batch_size"\s*:\s*1\b/);
    expect(config).toMatch(/"max_concurrency"\s*:\s*1\b/);
    const maxRetries = /"max_retries"\s*:\s*(\d+)/.exec(config)?.[1];
    expect(maxRetries).toBeDefined();
    // consume の MAX_RETRIES は、retry を使い切った失敗を見分けるため、この値と同じにする
    const consume = readFileSync(new URL("../src/handler/github/consume.ts", import.meta.url), "utf8");
    expect(/const MAX_RETRIES = (\d+);/.exec(consume)?.[1]).toBe(maxRetries);
  });
});
