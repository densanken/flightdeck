import { describe, expect, it } from "vitest";

import { isRecord, positiveSafeInteger } from "./type-guards.js";

describe("isRecord", () => {
  it("plain object を record として受け入れる", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ id: 1 })).toBe(true);
  });

  it("array、null、primitive を拒否する", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ id: 1 }])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("value")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe("positiveSafeInteger", () => {
  it("1 以上の安全な整数を受け入れる", () => {
    expect(positiveSafeInteger(1)).toBe(true);
    expect(positiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("0 以下、非整数、安全な範囲外、number 以外を拒否する", () => {
    expect(positiveSafeInteger(0)).toBe(false);
    expect(positiveSafeInteger(-1)).toBe(false);
    expect(positiveSafeInteger(1.5)).toBe(false);
    expect(positiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(positiveSafeInteger(Number.NaN)).toBe(false);
    expect(positiveSafeInteger(Number.POSITIVE_INFINITY)).toBe(false);
    expect(positiveSafeInteger("1")).toBe(false);
    expect(positiveSafeInteger(null)).toBe(false);
  });
});
