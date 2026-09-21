import { describe, expect, it } from "vitest";

import { jsonResponse, requestError } from "./http-response.js";

describe("jsonResponse", () => {
  it("既定の security header と JSON の Content-Type を設定する", async () => {
    const response = jsonResponse({ ok: true }, 200);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("呼び出し元が渡した header で既定値を上書きし、新しい header も追加できる", () => {
    const response = jsonResponse({ ok: false }, 401, { "X-Content-Type-Options": "custom", "X-Extra": "1" });

    expect(response.headers.get("X-Content-Type-Options")).toBe("custom");
    expect(response.headers.get("X-Extra")).toBe("1");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("requestError", () => {
  it("既定の security header 付きで 400 を返す", () => {
    const response = requestError("INVALID_PAYLOAD");

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("413 など任意の status を指定できる", () => {
    expect(requestError("INVALID_REQUEST", 413).status).toBe(413);
  });
});
