import { describe, expect, it } from "vitest";

import { chooseConfig, MAX_TARGETS, parseConfig as parseConfigText } from "./config.js";

// dispatch の section の内容を、JSON（YAML の一部）で渡す
const parseConfig = (raw: unknown) => parseConfigText(JSON.stringify({ dispatch: raw }));

const target = (overrides: Record<string, unknown> = {}) => ({
  repository: "o/parent",
  path: "contents",
  ...overrides,
});

describe("parseConfig", () => {
  it("base-branch を省略すると baseBranch は undefined になる", () => {
    expect(parseConfig({ targets: [target()] })).toEqual([
      { repository: "o/parent", path: "contents", baseBranch: undefined },
    ]);
  });

  it("base-branch を明示するとそのまま保持する", () => {
    expect(parseConfig({ targets: [target({ "base-branch": "develop" })] })[0]?.baseBranch).toBe("develop");
  });

  it("targets が空配列なら有効で管理対象ゼロ", () => {
    expect(parseConfig({ targets: [] })).toEqual([]);
  });

  it.each([
    ["camelCase の baseBranch", { targets: [target({ baseBranch: "x" })] }],
    ["snake_case の base_branch", { targets: [target({ base_branch: "x" })] }],
    ["未知のトップレベル項目", { targets: [], extra: 1 }],
    ["targets がない", {}],
    ["null", null],
    ["repository が owner/repo 形式でない", { targets: [target({ repository: "parent" })] }],
    ["repository に余計な階層がある", { targets: [target({ repository: "a/b/c" })] }],
    ["repository が .. を指す", { targets: [target({ repository: "o/.." })] }],
    ["repository が . を指す", { targets: [target({ repository: "o/." })] }],
    ["path が空", { targets: [target({ path: "" })] }],
    ["path が / だけ", { targets: [target({ path: "/" })] }],
    ["path の先頭に / が 2 つある", { targets: [target({ path: "//contents" })] }],
    ["path に空セグメントがある", { targets: [target({ path: "a//b" })] }],
    ["path に .. がある", { targets: [target({ path: "a/../b" })] }],
    ["path に . がある", { targets: [target({ path: "./a" })] }],
    ["path に制御文字がある", { targets: [target({ path: "a\nb" })] }],
    ["base-branch に .. の segment がある", { targets: [target({ "base-branch": "a/../b" })] }],
    ["base-branch が / で始まる", { targets: [target({ "base-branch": "/a" })] }],
    ["base-branch が / で終わる", { targets: [target({ "base-branch": "a/" })] }],
    ["base-branch に // がある", { targets: [target({ "base-branch": "a//b" })] }],
    ["base-branch が空", { targets: [target({ "base-branch": "" })] }],
    ["base-branch が文字列でない", { targets: [target({ "base-branch": 1 })] }],
    ["parent の重複（大文字小文字を無視）", { targets: [target(), target({ repository: "O/Parent", path: "other" })] }],
    [
      "target 件数の上限超過",
      { targets: Array.from({ length: MAX_TARGETS + 1 }, (_, i) => target({ repository: `o/r${String(i)}` })) },
    ],
  ])("%s を拒否する", (_name, raw) => {
    expect(() => parseConfig(raw)).toThrow(expect.objectContaining({ kind: "config" }));
  });
});

describe("parseConfig の YAML と共有ファイル", () => {
  it("dispatch の section を読む", () => {
    expect(parseConfigText("dispatch:\n  targets:\n    - repository: o/x\n      path: sub\n")).toEqual([
      { repository: "o/x", path: "sub", baseBranch: undefined },
    ]);
  });

  it.each(["/sub", "sub/", "/sub/"])("path %s の先頭と末尾の / を取り除く", (path) => {
    expect(parseConfigText(`dispatch:\n  targets:\n    - repository: o/x\n      path: ${path}\n`)).toEqual([
      { repository: "o/x", path: "sub", baseBranch: undefined },
    ]);
  });

  it("他の app の section（トップレベルの未知の key）は無視する", () => {
    const text = "preflight:\n  anything: [1, 2]\ndispatch:\n  targets: []\ntakeoff: {}\nunknown: 1\n";
    expect(parseConfigText(text)).toEqual([]);
  });

  it.each([
    ["dispatch の key がない", "preflight: {}\n"],
    ["空のファイル", ""],
    ["コメントだけ", "# nothing\n"],
  ])("%s は、Dispatch の設定がないものとして空にする", (_name, text) => {
    expect(parseConfigText(text)).toEqual([]);
  });

  it.each([
    ["null", "dispatch:\n"],
    ["list", "dispatch:\n  - a\n"],
    ["文字列", "dispatch: text\n"],
    ["targets がない", "dispatch: {}\n"],
    ["dispatch の中の未知の key", "dispatch:\n  targets: []\n  extra: 1\n"],
    ["ファイル全体が mapping でない", "- dispatch\n"],
  ])("dispatch が %s なら設定エラーにする", (_name, text) => {
    expect(() => parseConfigText(text)).toThrow(expect.objectContaining({ kind: "config" }));
  });

  it.each([
    ["構文エラー", "dispatch: [unclosed"],
    ["重複キー", "dispatch: {targets: []}\ndispatch: {targets: []}\n"],
    ["未知の tag", "dispatch: !foo {}\n"],
    ["!!js/function", "dispatch: !!js/function 'x'\n"],
    ["alias", "a: &x {targets: []}\ndispatch: *x\n"],
    ["他の app の section の中の alias", "other: &x [1]\nmore: *x\ndispatch: {targets: []}\n"],
    ["サイズ超過", `dispatch: {targets: []}\n# ${"x".repeat(40 * 1024)}\n`],
  ])("%s は、ファイル全体の規則で設定エラーにする", (_name, text) => {
    expect(() => parseConfigText(text)).toThrow(expect.objectContaining({ kind: "config" }));
  });
});

describe("chooseConfig", () => {
  it("どちらもなければ undefined、1 つだけならそれを使う", () => {
    expect(chooseConfig([])).toBeUndefined();
    expect(chooseConfig([{ path: ".github/flightdeck.yaml", text: "a" }])).toEqual({
      path: ".github/flightdeck.yaml",
      text: "a",
    });
  });

  it("読めないファイル（null）は、空の設定と見なさず設定エラーにする", () => {
    expect(() => chooseConfig([{ path: ".github/flightdeck.yml", text: null }])).toThrow(
      expect.objectContaining({ kind: "config", message: "flightdeck config cannot be read" })
    );
  });

  it("両方あれば設定エラー", () => {
    expect(() =>
      chooseConfig([
        { path: ".github/flightdeck.yml", text: "a" },
        { path: ".github/flightdeck.yaml", text: "b" },
      ])
    ).toThrow(expect.objectContaining({ kind: "config", message: "both flightdeck.yml and flightdeck.yaml exist" }));
  });
});
