import { describe, expect, it } from "vitest";

import { isManagedBranch, managedBranchName, sourceOf, updateTitle, withAutoclosedSuffix } from "./naming.js";

describe("naming", () => {
  it("branch 名と title を仕様どおりに組み立てる", () => {
    expect(managedBranchName("densanken/blog-contents")).toBe("flightdeck-dispatch/densanken/blog-contents");
    expect(updateTitle("densanken/blog-contents")).toBe("chore(submodule): update densanken/blog-contents");
  });

  it("管理 branch の prefix を判定する", () => {
    expect(isManagedBranch("flightdeck-dispatch/a/b")).toBe(true);
    expect(isManagedBranch("feature/flightdeck-dispatch/a")).toBe(false);
  });

  it("管理 branch 名から source を一意に戻せる（a-b/c と a/b-c も区別する）", () => {
    for (const source of ["a-b/c", "a/b-c", "densanken/blog.contents"]) {
      expect(sourceOf(managedBranchName(source))).toBe(source);
    }
  });

  it.each([
    "main",
    "flightdeck-dispatch/",
    "flightdeck-dispatch/owner",
    "flightdeck-dispatch/o/r/extra",
    "flightdeck-dispatch/o/..",
    "other/flightdeck-dispatch/o/r",
  ])("%s は source を戻せない", (branch) => {
    expect(sourceOf(branch)).toBeUndefined();
  });

  it.each(["o/.github", "o/a..b", "o/x.lock", "o/src."])(
    "git の ref の component として使えない名前（%s）は、書き込みの前に設定エラーにする",
    (source) => {
      expect(() => managedBranchName(source)).toThrow(expect.objectContaining({ kind: "config" }));
    }
  );

  it("autoclosed suffix を 1 回だけ付与する", () => {
    const once = withAutoclosedSuffix("chore(submodule): update a/b");
    expect(once).toBe("chore(submodule): update a/b - autoclosed");
    expect(withAutoclosedSuffix(once)).toBe(once);
  });

  it("suffix を付けたタイトルが 256 文字に収まるよう、元のタイトルを切り詰める。すでに付いていればそのまま", () => {
    const long = "x".repeat(300);
    const closed = withAutoclosedSuffix(long);
    expect(closed).toHaveLength(256);
    expect(closed.endsWith(" - autoclosed")).toBe(true);
    expect(withAutoclosedSuffix(closed)).toBe(closed);
    expect(withAutoclosedSuffix("x".repeat(243))).toHaveLength(256);
    // 切り口が surrogate pair の途中なら、その文字を落とす
    const emoji = withAutoclosedSuffix(`${"x".repeat(242)}😀😀`);
    expect(emoji).toBe(`${"x".repeat(242)} - autoclosed`);
  });
});
