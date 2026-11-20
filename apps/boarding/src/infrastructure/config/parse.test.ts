import { describe, expect, it } from "vitest";

import { readEditors, readMetaKeys, readWebsite } from "./parse.js";

import type { RootFiles } from "../../usecase/evaluate/dependencies.js";

const empty: RootFiles = { metaYaml: null, metaYml: null, profileYaml: null, profileYml: null };

describe("readEditors", () => {
  it("個人と Team を正規化する", () => {
    expect(readEditors({ ...empty, metaYaml: 'editors: [Alice, "team:Blog"]' })).toEqual([
      { login: "alice", type: "user" },
      { slug: "blog", type: "team" },
    ]);
  });

  it("空や重複した Editor も正規化して返す", () => {
    expect(readEditors({ ...empty, metaYaml: "editors: []" })).toEqual([]);
    expect(readEditors({ ...empty, metaYaml: "editors: [Alice, alice]" })).toEqual([
      { type: "user", login: "alice" },
      { type: "user", login: "alice" },
    ]);
  });

  it("YAML の重複キーを拒否する", () => {
    expect(() => readEditors({ ...empty, metaYaml: "editors: [alice]\neditors: [bob]" })).toThrow();
  });
});

describe("readWebsite", () => {
  it("不正な profile を profile のエラーにする", () => {
    expect(() => readWebsite({ ...empty, profileYaml: "website: [a]" })).toThrow(
      expect.objectContaining({ code: "INVALID_PROFILE" })
    );
    expect(() => readWebsite({ ...empty, profileYaml: "website: [" })).toThrow(
      expect.objectContaining({ code: "INVALID_PROFILE" })
    );
  });

  it("website の値を読む", () => {
    expect(readWebsite({ ...empty, profileYaml: 'website: "https://example.com"' })).toBe("https://example.com");
  });
});

describe("meta のトップレベルのキー", () => {
  it("通常のオブジェクトからキーを返す", () => {
    expect(readMetaKeys({ ...empty, metaYaml: "editors: [alice]" })).toEqual(["editors"]);
    expect(readMetaKeys({ ...empty, metaYml: "editors: [bob]\nextra: value" })).toEqual(["editors", "extra"]);
  });

  it.each(["!!set {foo: null}", "!!omap [{foo: bar}]", "[alice]", "null"])(
    "通常のオブジェクトではない %s はキーを返さない",
    (text) => {
      expect(readMetaKeys({ ...empty, metaYaml: text })).toBeNull();
    }
  );

  it("meta がなければキーを返さない", () => {
    expect(readMetaKeys(empty)).toBeNull();
  });

  it("通常の meta と profile の読み込みに影響しない", () => {
    expect(readEditors({ ...empty, metaYaml: "editors: [alice]\nextra: !!set {foo: null}" })).toEqual([
      { type: "user", login: "alice" },
    ]);
    expect(readWebsite({ ...empty, profileYaml: "website: https://example.com\nextra: !!set {foo: null}" })).toBe(
      "https://example.com"
    );
  });
});
