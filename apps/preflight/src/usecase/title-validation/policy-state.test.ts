import { describe, expect, it } from "vitest";

import { sameAssociatedPullRequests } from "./policy-state.js";

describe("sameAssociatedPullRequests", () => {
  it("type 方針の内容と制限の有無を比較する", () => {
    const pullRequest = { number: 7, title: "feat: add feature", headSha: "abc123", draft: false };
    const withPolicy = { ...pullRequest, typePolicy: { types: ["feat", "docs"], restricted: true } };

    expect(
      sameAssociatedPullRequests([withPolicy], [{ ...withPolicy, typePolicy: { ...withPolicy.typePolicy } }])
    ).toBe(true);
    expect(sameAssociatedPullRequests([withPolicy], [pullRequest])).toBe(false);
    expect(
      sameAssociatedPullRequests([withPolicy], [{ ...withPolicy, typePolicy: { types: ["feat"], restricted: true } }])
    ).toBe(false);
    expect(
      sameAssociatedPullRequests(
        [withPolicy],
        [{ ...withPolicy, typePolicy: { types: ["feat", "docs"], restricted: false } }]
      )
    ).toBe(false);
  });
});
