import { describe, expect, it } from "vitest";

import { getBotUserId, getGitHubAppCredentials, getGitHubAppId } from "./env.js";

import type { Env } from "./env.js";

describe("getGitHubAppId", () => {
  it("数値 App ID を取得する", () => {
    expect(getGitHubAppId({ GITHUB_APP_ID: "123" } as Env)).toBe(123);
  });

  it("秘密鍵の取得時にも App ID を検証する", () => {
    expect(() => getGitHubAppCredentials({ GITHUB_APP_ID: "-1", GITHUB_PRIVATE_KEY: "key" } as Env)).toThrow();
  });

  it("Bot の ID も正の整数として検証する", () => {
    expect(getBotUserId({ GITHUB_APP_BOT_USER_ID: "45" } as Env)).toBe(45);
    expect(() => getBotUserId({ GITHUB_APP_BOT_USER_ID: "1e3" } as Env)).toThrow();
  });

  it.each(["0", "-1", "1.5", "1e3", "9007199254740992"])("不正な App ID %s を拒否する", (value) => {
    expect(() => getGitHubAppId({ GITHUB_APP_ID: value } as Env)).toThrow();
  });
});
