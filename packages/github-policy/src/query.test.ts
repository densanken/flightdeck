import { describe, expect, it } from "vitest";

import { PR_QUERY } from "./query.js";

describe("PR の取得 query", () => {
  it.each(["AutoMergeEnabledEvent", "AutoMergeDisabledEvent"])("%s の actor と時刻を取得する", (type) => {
    expect(PR_QUERY).toContain(`... on ${type} { createdAt actor {`);
  });
});
