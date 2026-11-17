import { describe, expect, it } from "vitest";

import { chooseConfig, parseAutopilotConfig, parseConfigDocument } from "./config.js";

describe("共有設定", () => {
  it("null と省略値では有効を既定にする", () => {
    for (const text of ["", "dispatch: {}", "autopilot:", "autopilot:\n  renovate-stale:"]) {
      expect(parseAutopilotConfig(text)).toEqual({ renovateStale: true });
    }

    expect(parseAutopilotConfig("autopilot:\n  renovate-stale: false")).toEqual({ renovateStale: false });
  });

  it("autopilot の設定が配列なら拒否する", () => {
    expect(() => parseAutopilotConfig("autopilot: []")).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it.each(["[]", "42", "false"])("トップレベルが mapping でない設定を拒否する", (text) => {
    expect(() => parseConfigDocument(text)).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it("未知の項目、型不一致、不正な YAML を拒否する", () => {
    for (const text of ["autopilot:\n  unknown: true", "autopilot:\n  renovate-stale: no", "other: !unknown x"]) {
      expect(() => parseAutopilotConfig(text)).toThrow();
    }

    expect(() => parseConfigDocument("a: &a [1]\nb: *a")).toThrow();
    expect(() => parseConfigDocument("a: " + "x".repeat(32768))).toThrow();
    expect(() =>
      chooseConfig([
        { path: "a", text: "" },
        { path: "b", text: "" },
      ])
    ).toThrow();
  });
});
