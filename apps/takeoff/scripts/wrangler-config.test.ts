import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("wrangler public endpoint policy", () => {
  it("workers.dev と preview URL を無効にし、公開 route を Dashboard 管理に保つ", () => {
    expect(config).toMatch(/"workers_dev"\s*:\s*false/);
    expect(config).toMatch(/"preview_urls"\s*:\s*false/);
    expect(config).not.toMatch(/"routes?"\s*:/);
  });

  it("Cron と Queue を使わず、Webhook を request 内で同期処理する", () => {
    expect(config).not.toMatch(/"crons?"\s*:/);
    expect(config).not.toMatch(/"queues?"\s*:/);
  });
});
