import { describe, expect, it } from "vitest";

import { interventionLabel } from "./management.js";
import { mergeCheckbox, mergeLabel, mergeRequested } from "./merge-request.js";

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
