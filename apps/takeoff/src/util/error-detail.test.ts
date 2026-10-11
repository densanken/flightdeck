import { describe, expect, it } from "vitest";

import { errorDetail } from "./error-detail.js";

describe("errorDetail", () => {
  it("Error インスタンスは name と message を結合する", () => {
    expect(errorDetail(new Error("boom"))).toBe("Error: boom");
  });

  it("Error の subclass は subclass の name を使う", () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }

    expect(errorDetail(new CustomError("failed"))).toBe("CustomError: failed");
  });

  it("Error 以外は String へ変換する", () => {
    expect(errorDetail("plain string")).toBe("plain string");
    expect(errorDetail(42)).toBe("42");
    expect(errorDetail(null)).toBe("null");
    expect(errorDetail(undefined)).toBe("undefined");
  });

  it("stack trace を含めない", () => {
    const error = new Error("boom");
    expect(error.stack).toBeDefined();
    expect(errorDetail(error)).toBe("Error: boom");
    expect(errorDetail(error)).not.toContain("\n");
  });
});
