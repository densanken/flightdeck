import { describe, expect, it } from "vitest";

import { commentBody, headVerdict, needsTitleTypePolicy, validateTitle } from "./title-policy.js";

describe("title policy", () => {
  it("gate 対象と処理対象の draft PR に type 方針を適用する", () => {
    expect(needsTitleTypePolicy({ number: 7, draft: false })).toBe(true);
    expect(needsTitleTypePolicy({ number: 7, draft: true }, 7)).toBe(true);
    expect(needsTitleTypePolicy({ number: 8, draft: true }, 7)).toBe(false);
    expect(needsTitleTypePolicy({ number: 8, draft: true })).toBe(false);
  });

  it("設定の有無に応じて許可 type を検証する", () => {
    expect(validateTitle({ title: "feat: add feature" }).valid).toBe(true);
    expect(validateTitle({ title: "content: update text" }).valid).toBe(false);
    expect(
      validateTitle({ title: "content: update text", typePolicy: { types: ["content"], restricted: true } }).valid
    ).toBe(true);
    expect(
      validateTitle({ title: "feat: add feature", typePolicy: { types: ["content"], restricted: true } })
    ).toMatchObject({
      reason: "unsupported_type",
    });
  });

  it("type の制限による失敗を status とコメントに表示する", () => {
    const current = {
      title: "feat: add feature",
      typePolicy: { types: ["content"], restricted: true },
      state: "open" as const,
      draft: false,
    };
    const verdict = headVerdict({ associatedPullRequests: [{ ...current, number: 7 }] });

    expect(verdict.state).toBe("failure");
    expect(verdict.message.description).toBe("PR #7: 使用可能な type が制限されています");
    expect(commentBody({ current, currentValidation: validateTitle(current) })).toContain("`content`");
  });

  it("別の理由による失敗には type 制限の status を表示しない", () => {
    const verdict = headVerdict({
      associatedPullRequests: [
        { number: 7, title: "content: invalid.", draft: false, typePolicy: { types: ["content"], restricted: true } },
      ],
    });

    expect(verdict.message.description).toBe("PR #7 のタイトルを修正する必要があります");
  });

  it("複数 PR が無効なときはすべての番号を status に表示する", () => {
    const verdict = headVerdict({
      associatedPullRequests: [
        { number: 7, title: "feat: add feature", draft: false, typePolicy: { types: ["docs"], restricted: true } },
        { number: 8, title: "invalid title", draft: false },
      ],
    });
    expect(verdict.message.description).toContain("#7, #8");
    expect(verdict.message.description).not.toContain("paths");
  });

  it("paths 外を含む場合は追加 type を示し、制限による失敗とは表示しない", () => {
    const current = {
      title: "unknown: update text",
      typePolicy: { types: ["feat", "content"], restricted: false },
      state: "open" as const,
      draft: false,
    };
    const comment = commentBody({ current, currentValidation: validateTitle(current) });
    expect(comment).toContain("`content`");
    expect(comment).not.toContain("変更 paths により");
    expect(headVerdict({ associatedPullRequests: [{ ...current, number: 7 }] }).message.description).not.toContain(
      "paths"
    );
  });
});
