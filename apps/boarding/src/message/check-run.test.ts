import { describe, expect, it } from "vitest";

import { checkOutput } from "./check-run.js";

describe("Check Run の文面", () => {
  it.each([
    [{ status: "allowed", reason: "AUTHORIZED" }, "必要な同意を確認済み"],
    [{ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, "著者の変更なし"],
    [{ status: "waiting", reason: "EDITOR_APPROVAL_MISSING" }, "Editor の承認不足"],
    [{ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" }, "authors 以外の変更を含む"],
    [{ status: "error", reason: "API_ERROR" }, "GitHub の情報を取得できない"],
  ] as const)("%o の文言と管理コメントへの案内を返す", (result, title) => {
    const output = checkOutput(result);
    expect(output.title).toBe(title);
    expect(output.summary).toContain("PR の管理コメント");
  });

  it("評価中は完了を待つよう案内し管理コメントを参照しない", () => {
    const output = checkOutput({ status: "waiting", reason: "EVALUATING" });
    expect(output.title).toBe("評価中");
    expect(output.summary).toContain("評価の完了をお待ちください");
    expect(output.summary).not.toContain("管理コメント");
  });

  it.each(["API_ERROR", "INCOMPLETE_DATA"] as const)("%s は再実行を案内する", (reason) => {
    expect(checkOutput({ status: "error", reason }).summary).toContain("再実行");
  });

  it("認可対象外の変更には通常のレビューを案内する", () => {
    expect(checkOutput({ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }).summary).toContain("通常のレビュー");
  });

  it("対象外ファイルの対処を示す", () => {
    const output = checkOutput({ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" });
    expect(output.summary).toContain("対象外ファイルを PR から取り除いて push");
  });
});
