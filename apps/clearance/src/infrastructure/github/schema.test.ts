import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { searchResponse } from "./schema.js";

describe("レビュー検索の件数", () => {
  it("安全な整数の範囲と非負の制約を検証する", () => {
    const response = (totalCount: number) => ({
      search: {
        nodes: [{ number: 1, headRefOid: "a".repeat(40), author: null, latestReviews: { totalCount, nodes: [] } }],
      },
    });

    expect(v.safeParse(searchResponse, response(0)).success).toBe(true);
    expect(v.safeParse(searchResponse, response(-1)).success).toBe(false);
    expect(v.safeParse(searchResponse, response(Number.MAX_SAFE_INTEGER + 1)).success).toBe(false);
  });
});
