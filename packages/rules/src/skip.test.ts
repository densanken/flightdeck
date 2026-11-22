import { describe, expect, it } from "vitest";

import { STALE_MS } from "./policy.js";
import { skipUntil } from "./skip.js";

const now = Date.parse("2026-11-23T00:00:00Z");
const enabled = "**Automerge**: Enabled.";
const disabled = "**Automerge**: Disabled by config.";
const young = new Date(now - STALE_MS / 2).toISOString();
const old = new Date(now - STALE_MS * 2).toISOString();

describe("skipUntil", () => {
  it("作成から 30 日未満の Renovate PR は、30 日経つ時刻まで見送る", () => {
    expect(skipUntil("renovate-stale", { state: "OPEN", createdAt: young, body: disabled }, now)).toBe(
      Date.parse(young) + STALE_MS
    );
  });

  it("30 日経った PR は、automerge が有効なら 1 時間見送る", () => {
    expect(skipUntil("renovate-stale", { state: "OPEN", createdAt: old, body: enabled }, now)).toBe(now + 3_600_000);
  });

  it("30 日経って automerge が無効な PR は、見送らない", () => {
    expect(skipUntil("renovate-stale", { state: "OPEN", createdAt: old, body: disabled }, now)).toBeUndefined();
  });

  it("Renovate 以外と、open でない PR は、見送らない", () => {
    expect(skipUntil("dispatch", { state: "OPEN", createdAt: young, body: enabled }, now)).toBeUndefined();
    expect(skipUntil(null, { state: "OPEN", createdAt: young, body: enabled }, now)).toBeUndefined();
    expect(skipUntil("renovate-stale", { state: "CLOSED", createdAt: young, body: enabled }, now)).toBeUndefined();
  });
});
