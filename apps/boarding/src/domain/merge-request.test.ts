import { describe, expect, it } from "vitest";

import { mergeCheckbox, mergeRequested } from "./merge-request.js";

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
    expect(mergeCheckbox(body)).toBe(expected);
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
    expect(mergeRequested(versions, 1)).toBe(expected);
  });
});
