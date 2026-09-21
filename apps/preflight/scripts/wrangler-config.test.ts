import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("wrangler public endpoint policy", () => {
  it("workers.dev と preview URL を無効にし、公開 route を Dashboard 管理に保つ", () => {
    expect(config).toMatch(/"workers_dev"\s*:\s*false/);
    expect(config).toMatch(/"preview_urls"\s*:\s*false/);
    expect(config).not.toMatch(/"routes?"\s*:/);
  });

  it("Cron と DLQ を使わず、GitHub Webhook Queue の retry 後に破棄する", () => {
    expect(config).not.toMatch(/"crons?"\s*:/);
    expect(config).toMatch(/"binding"\s*:\s*"GITHUB_WEBHOOK_QUEUE"/);
    expect(config).toMatch(/"queue"\s*:\s*"preflight-github-webhooks"/);
    expect(config).not.toMatch(/"dead_letter_queue"\s*:/);
    expect(config).toMatch(/"max_retries"\s*:\s*5/);
    expect(config).toMatch(/"retry_delay"\s*:\s*60/);
  });

  it("batch を逐次処理しても consumer の wall time 上限 15 分に収まる max_batch_size を保つ", () => {
    // handler の hard deadline 60 秒 × max_batch_size が 15 分未満であること
    const maxBatchSize = /"max_batch_size"\s*:\s*(\d+)/.exec(config)?.[1];
    expect(maxBatchSize).toBeDefined();
    expect(Number(maxBatchSize) * 60).toBeLessThan(15 * 60);
  });
});
