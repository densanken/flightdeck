import { describe, expect, it, vi } from "vitest";

import { ciStatus } from "./ci.js";

const action = { name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } };

describe("CI の取得と判定", () => {
  it.each([
    { name: "Check Run がない場合", checks: [], statuses: [], expected: "pending" },
    { name: "実行中", checks: [{ ...action, status: "in_progress" }], statuses: [], expected: "pending" },
    { name: "失敗", checks: [{ ...action, conclusion: "failure" }], statuses: [], expected: "blocked" },
    { name: "status の失敗", checks: [], statuses: [{ context: "external", state: "failure" }], expected: "blocked" },
  ] as const)("$name は rules を取得せず $expected を返す", async ({ checks, statuses, expected }) => {
    const rules = vi.fn().mockResolvedValue([{ context: "required", integrationId: null }]);
    expect(await ciStatus({ rules }, { checks: [...checks], statuses: [...statuses], baseBranch: "main" })).toBe(
      expected
    );
    expect(rules).not.toHaveBeenCalled();
  });

  it("CI の成功後に rules を取得して必須チェックを検証する", async () => {
    const rules = vi.fn().mockResolvedValue([{ context: "required", integrationId: null }]);
    const pr = { checks: [action], statuses: [], baseBranch: "main" };
    expect(await ciStatus({ rules }, pr)).toBe("blocked");
    expect(rules).toHaveBeenCalledWith("main");

    rules.mockResolvedValue([]);
    expect(await ciStatus({ rules }, pr)).toBe("passed");
  });

  it("rules の取得失敗を伝播する", async () => {
    const error = new Error("unavailable");
    const rules = vi.fn().mockRejectedValue(error);
    await expect(ciStatus({ rules }, { checks: [action], statuses: [], baseBranch: "main" })).rejects.toBe(error);
  });
});
