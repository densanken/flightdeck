import { describe, expect, it } from "vitest";

import { consentLabels, consentStatus, needsConsentHistory } from "./consent.js";

const checked = (label: string) => `- [x] ${label}`;
const unchecked = (label: string) => `- [ ] ${label}`;
const allChecked = consentLabels.map(checked).join("\n");
const [first = "", second = "", third = ""] = consentLabels;

describe("確認事項の履歴の要否", () => {
  it.each(consentLabels)("チェックした欄 %s があれば履歴を取得する", (label) => {
    expect(needsConsentHistory(checked(label))).toBe(true);
  });

  it("チェックした欄がなければ履歴を取得しない", () => {
    expect(needsConsentHistory(consentLabels.map(unchecked).join("\n"))).toBe(false);
    expect(needsConsentHistory("")).toBe(false);
  });
});

describe("確認事項の状態", () => {
  it("すべてを PR 作成者がチェックしていれば agreed にする", () => {
    expect(consentStatus(allChecked, [{ body: allChecked, editorId: 1 }], 1)).toEqual({ state: "agreed" });
  });

  it("本文が空なら未チェックの項目をすべて返す", () => {
    expect(consentStatus("", null, 1)).toEqual({ state: "unchecked", missing: consentLabels });
  });

  it("一部が未チェックなら未チェックの項目だけを返し、履歴は見ない", () => {
    const body = [checked(first), unchecked(second), checked(third)].join("\n");
    expect(consentStatus(body, null, 1)).toEqual({ state: "unchecked", missing: [second] });
  });

  it.each([
    ["重複した行", `${allChecked}\n${checked(first)}`],
    ["チェック記号の誤り", allChecked.replace("[x]", "[o]")],
    ["ラベルの書き換え", allChecked.replace(first, `${first}です`)],
  ])("%s は invalid にする", (_name, body) => {
    expect(consentStatus(body, [{ body, editorId: 1 }], 1)).toEqual({ state: "invalid" });
  });

  it("形式の不正は未チェックの項目より優先する", () => {
    const body = `${checked(first)}\n${checked(first)}\n${unchecked(second)}`;
    expect(consentStatus(body, null, 1)).toEqual({ state: "invalid" });
  });

  it.each([
    ["履歴がない", null],
    ["履歴の最新の本文が一致しない", [{ body: "別の本文", editorId: 1 }]],
    ["履歴が空", []],
  ])("%s ときは history_unavailable にする", (_name, versions) => {
    expect(consentStatus(allChecked, versions, 1)).toEqual({ state: "history_unavailable" });
  });

  it("PR 作成者以外がチェックした項目があれば not_author にする", () => {
    const partial = [checked(first), checked(second), unchecked(third)].join("\n");
    expect(
      consentStatus(
        allChecked,
        [
          { body: partial, editorId: 1 },
          { body: allChecked, editorId: 2 },
        ],
        1
      )
    ).toEqual({ state: "not_author" });
  });

  it("本人以外が入れた後に本人が外して入れ直せば agreed にする", () => {
    const off = consentLabels.map(unchecked).join("\n");
    expect(
      consentStatus(
        allChecked,
        [
          { body: off, editorId: 1 },
          { body: allChecked, editorId: 2 },
          { body: off, editorId: 1 },
          { body: allChecked, editorId: 1 },
        ],
        1
      )
    ).toEqual({ state: "agreed" });
  });
});
