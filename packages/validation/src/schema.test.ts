import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { commitSha, githubId, repositoryFullName } from "./schema.js";

describe("共通スキーマ", () => {
  it("ID は正の安全な整数のみ受け付ける", () => {
    expect(v.safeParse(githubId, 1).success).toBe(true);
    expect(v.safeParse(githubId, 0).success).toBe(false);
    expect(v.safeParse(githubId, Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it("SHA は 40 桁の 16 進数を受け付ける", () => {
    expect(v.safeParse(commitSha, "a".repeat(40)).success).toBe(true);
    expect(v.safeParse(commitSha, "a".repeat(39)).success).toBe(false);
  });

  it("リポジトリは owner と名前を検証する", () => {
    expect(v.safeParse(repositoryFullName, "owner/repo").success).toBe(true);
    expect(v.safeParse(repositoryFullName, "owner/..").success).toBe(false);
  });
});
