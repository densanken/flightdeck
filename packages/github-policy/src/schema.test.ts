import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { associatedResponse } from "./schema.js";

describe("関連 PR の件数", () => {
  it("安全な整数の範囲と非負の制約を検証する", () => {
    const response = (totalCount: number) => ({
      repository: { object: { associatedPullRequests: { totalCount, nodes: [] }, parents: { nodes: [] } } },
    });

    expect(v.safeParse(associatedResponse, response(0)).success).toBe(true);
    expect(v.safeParse(associatedResponse, response(-1)).success).toBe(false);
    expect(v.safeParse(associatedResponse, response(Number.MAX_SAFE_INTEGER + 1)).success).toBe(false);
  });
});
