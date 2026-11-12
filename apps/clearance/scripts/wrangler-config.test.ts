import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("wrangler config", () => {
  it("変数を Dashboard で管理する", () => {
    expect(config).not.toMatch(/"vars"\s*:/);
  });

  it("workers.dev と preview URL を無効にし、公開 route を Dashboard 管理に保つ", () => {
    expect(config).toMatch(/"workers_dev"\s*:\s*false/);
    expect(config).toMatch(/"preview_urls"\s*:\s*false/);
    expect(config).not.toMatch(/"routes?"\s*:/);
  });

  it("Queue、Cron、KV、D1、R2、Durable Objects を使わない", () => {
    expect(config).not.toMatch(/"(queues|crons?|kv_namespaces|d1_databases|r2_buckets|durable_objects|workflows)"\s*:/);
  });
});
