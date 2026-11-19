import { describe, expect, it } from "vitest";

import { interventionLabel } from "./management.js";
import {
  consentLabels,
  consentStatus,
  mergeCheckbox,
  mergeLabel,
  mergeRequested,
  needsConsentHistory,
} from "./merge-request.js";

const unchecked = "- [ ] すべてのチェックが成功したら自動マージする";
const checked = "- [x] すべてのチェックが成功したら自動マージする";
const version = (body: string, editorId: number) => ({ body, editorId });

describe("Merge 依頼のチェック欄", () => {
  it.each([
    ["", "unchecked"],
    [unchecked, "unchecked"],
    [checked, "checked"],
    [checked.replace("[x]", "[X]"), "checked"],
    [checked.replace("[x]", "[o]"), "invalid"],
    [`${checked}\n${unchecked}`, "invalid"],
    [`${checked}\n  ${unchecked}`, "invalid"],
    [`${checked}\n* [x] すべてのチェックが成功したら自動マージする`, "invalid"],
    [`引用 ${checked}`, "invalid"],
    [`${checked} `, "checked"],
    [`${checked} extra`, "invalid"],
    [`${checked}\n- [x すべてのチェックが成功したら自動マージする`, "invalid"],
    [`<!--\n${checked}\n-->`, "checked"],
    [`<pre>\n${checked}\n</pre>`, "checked"],
    [`<details>説明</details>\n${checked}\n<br>`, "checked"],
    [`<!-- closed --> <!--\n${checked}\n-->`, "checked"],
    [`${checked}\n\`\`\`\ncode\n\`\`\``, "checked"],
    [`\`\`\`\n${checked}\n\`\`\``, "checked"],
    [`\`\`\`\n\`\`\`foo\n${checked}\n\`\`\``, "checked"],
  ] as const)("本文 %s を %s と判定する", (body, expected) => {
    expect(mergeCheckbox(body, mergeLabel)).toBe(expected);
  });
});

describe("Merge 依頼の編集履歴", () => {
  it.each([
    [[version(checked, 1)], true],
    [[version(unchecked, 1), version(checked, 1)], true],
    [[version(unchecked, 1), version(checked, 2)], false],
    [[version(unchecked, 1), version(checked, 2), version(unchecked, 1), version(checked, 1)], true],
    [[version(checked, 1), version(unchecked, 2)], false],
    [[version(checked, 1), version(`${checked}\n別の行`, 2)], true],
    [[version(checked, 1), version(unchecked, 1), version(checked, 2)], false],
    [[version(unchecked, 1), version(checked.replace("[x]", "[o]"), 2), version(checked, 1)], true],
    [[], false],
  ])("編集履歴から依頼を判定する", (versions, expected) => {
    expect(mergeRequested(versions, 1, mergeLabel)).toBe(expected);
  });
});

describe("任意の文言のチェック欄", () => {
  it("指定した文言で状態とチェックした編集者を判定する", () => {
    const label = interventionLabel;
    const unchecked = `- [ ] ${label}`;
    const checked = `- [X] ${label}`;
    expect(mergeCheckbox(checked, label)).toBe("checked");
    expect(
      mergeRequested(
        [
          { body: unchecked, editorId: 1 },
          { body: checked, editorId: 2 },
        ],
        1,
        label
      )
    ).toBe(false);
    expect(
      mergeRequested(
        [
          { body: unchecked, editorId: 1 },
          { body: checked, editorId: 1 },
        ],
        1,
        label
      )
    ).toBe(true);
  });
});

describe("確認事項", () => {
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
});
