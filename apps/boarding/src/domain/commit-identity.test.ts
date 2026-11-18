import { describe, expect, it } from "vitest";

import { invalidCommitIdentities } from "./commit-identity.js";

const commit = { sha: "abc", authorId: 1, committerId: 1, committerLogin: "alice", signature: null };
const webFlow = {
  ...commit,
  committerId: 2,
  committerLogin: "web-flow",
  signature: { isValid: true, wasSignedByGitHub: true },
};

describe("invalidCommitIdentities", () => {
  it("作者とコミッターが PR 作成者なら署名なしでも許可する", () => {
    expect(invalidCommitIdentities([commit], 1)).toEqual([]);
  });

  it("GitHub が署名した有効な web-flow のコミットを許可する", () => {
    expect(invalidCommitIdentities([webFlow], 1)).toEqual([]);
  });

  it.each([
    { ...commit, authorId: null },
    { ...commit, authorId: 2 },
    { ...commit, committerId: null },
    { ...commit, committerId: 2 },
    { ...webFlow, authorId: 2 },
    { ...webFlow, committerId: null },
    { ...webFlow, committerLogin: "other" },
    { ...webFlow, signature: null },
    { ...webFlow, signature: { isValid: false, wasSignedByGitHub: true } },
    { ...webFlow, signature: { isValid: true, wasSignedByGitHub: false } },
  ])("作者またはコミッターを確認できないコミットを拒否する %#", (invalid) => {
    expect(invalidCommitIdentities([commit, invalid], 1)).toEqual([invalid]);
  });
});
