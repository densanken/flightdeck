import { describe, expect, it } from "vitest";

import { createGitHubAppJwt } from "./app-auth.js";

// 署名と秘密鍵の cache は @flightdeck/github-app-jwt で検証する
describe("createGitHubAppJwt", () => {
  it("不正な秘密鍵の内容を error message に出さない", async () => {
    const secret = "SECRET_PRIVATE_KEY_CONTENT";
    try {
      await createGitHubAppJwt({ appId: "12345", privateKeyPem: secret });
      throw new Error("Expected createGitHubAppJwt to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "GITHUB_AUTH_FAILED" });
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
  });
});
