import { describe, expect, it } from "vitest";

import { evaluateCi } from "./ci.js";

const success = { name: "test", status: "completed", conclusion: "success", app: { id: 1, slug: "github-actions" } };

describe("CI の判定", () => {
  it("status が成功でも GitHub Actions を要求する", () => {
    expect(evaluateCi([], [{ context: "PR Title", state: "success" }])).toBe("pending");
    expect(evaluateCi([success], [])).toBe("passed");
  });

  it("neutral の完了を通過として扱う", () => {
    expect(evaluateCi([success, { ...success, conclusion: "neutral" }], [])).toBe("passed");
  });

  it("全結果を検査する", () => {
    expect(evaluateCi([success, { ...success, conclusion: "failure" }], [])).toBe("blocked");
    expect(evaluateCi([success, { ...success, status: "queued", conclusion: null }], [])).toBe("pending");
    expect(
      evaluateCi(
        [
          { ...success, status: "queued", conclusion: null },
          { ...success, conclusion: "failure" },
        ],
        []
      )
    ).toBe("blocked");
    expect(
      evaluateCi([{ ...success, status: "queued", conclusion: null }], [{ context: "external", state: "failure" }])
    ).toBe("blocked");
    expect(evaluateCi([{ ...success, conclusion: "failure" }], [{ context: "external", state: "pending" }])).toBe(
      "blocked"
    );
  });
});
