import { describe, expect, it } from "vitest";

import { ConfigurationError, optionalPositiveInteger, requiredId, requiredIdList, requiredString } from "./env.js";

describe("環境変数", () => {
  it("必須文字列の空白を検査し元の値を返す", () => {
    expect(requiredString(" secret ", "SECRET")).toBe(" secret ");
    expect(() => requiredString(" ", "SECRET")).toThrow(ConfigurationError);
  });

  it("ID は前後の空白を除いた正の安全な整数のみ受け付ける", () => {
    expect(requiredId(" 123 ", "ID")).toBe(123);
    for (const value of ["0", "1e2", "9007199254740992"]) {
      expect(() => requiredId(value, "ID")).toThrow(ConfigurationError);
    }
    expect(requiredIdList("1, 2", "IDS")).toEqual([1, 2]);
    expect(() => requiredIdList("1,", "IDS")).toThrow(ConfigurationError);
  });

  it("省略時だけ既定値を返す", () => {
    expect(optionalPositiveInteger(" ", "TTL", 10)).toBe(10);
    expect(() => optionalPositiveInteger("0", "TTL", 10)).toThrow(ConfigurationError);
  });
});
