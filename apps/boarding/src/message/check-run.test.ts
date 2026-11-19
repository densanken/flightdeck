import { describe, expect, it } from "vitest";

import { checkOutput } from "./check-run.js";

describe("Check Run の文面", () => {
  it.each([
    [{ status: "allowed", reason: "AUTHORIZED" }, "authors/ の変更に問題はありません"],
    [{ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }, "authors/ の変更はありません"],
    [{ status: "waiting", reason: "EDITOR_APPROVAL_MISSING" }, "Editor の Approve が必要です"],
    [{ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" }, "authors/ 以外の変更が含まれています"],
    [{ status: "error", reason: "API_ERROR" }, "GitHub の情報を取得できませんでした"],
  ] as const)("%o の文言と管理コメントへの案内を返す", (result, title) => {
    const output = checkOutput(result);
    expect(output.title).toBe(title);
    expect(output.summary).toContain("PR の管理コメント");
  });

  it("確認中は状態を伝えて完了を待つよう案内し管理コメントを参照しない", () => {
    const output = checkOutput({ status: "waiting", reason: "EVALUATING" });
    expect(output.title).toBe("変更内容を確認しています");
    expect(output.summary).toBe("変更内容を確認しています。完了までしばらくお待ちください。");
    expect(output.summary).not.toContain("管理コメント");
  });

  it.each(["API_ERROR", "INCOMPLETE_DATA"] as const)("%s は再実行を案内する", (reason) => {
    expect(checkOutput({ status: "error", reason }).summary).toContain("再実行");
  });

  it("authors/ を変更していない PR には通常のレビューを案内する", () => {
    expect(checkOutput({ status: "not_applicable", reason: "NO_CONTENT_CHANGES" }).summary).toContain("通常のレビュー");
  });

  it("対象外ファイルの対処を示す", () => {
    const output = checkOutput({ status: "rejected", reason: "NON_CONTENT_CHANGE_FORBIDDEN" });
    expect(output.summary).toContain("`authors/` 以外の変更を PR から取り除いて push");
  });
});
