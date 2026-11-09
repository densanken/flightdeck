import { describe, expect, it } from "vitest";

import { pullRequestBody, withoutCommitList } from "./pull-request-body.js";

describe("pullRequestBody", () => {
  const input = {
    source: "a/src",
    sourceBranch: "main",
    sourceSha: "new",
    path: "contents",
    baseBranch: "develop",
    previousSha: "old",
    configPath: ".github/flightdeck.yaml",
    included: undefined,
  };

  it("source、target、更新前後の SHA と差分の link を記載し、commit がなければ一覧を載せない", () => {
    const body = pullRequestBody(input);
    expect(body).toContain("submodule ` contents ` を `a/src` と同期します。");
    expect(body).toContain("| Source | Target | 変更 |");
    expect(body).toContain("[a/src](https://github.com/a/src) (` main `)");
    expect(body).toContain("` contents ` (base: ` develop `)");
    expect(body).toContain(
      "[`old`](https://github.com/a/src/commit/old) → [`new`](https://github.com/a/src/commit/new)"
    );
    expect(body).toContain("https://github.com/a/src/compare/old...new");
    expect(body).toContain(
      "> この PR は [flightdeck dispatch](https://github.com/densanken/flightdeck/tree/main/apps/dispatch) が [a/src の設定](https://github.com/a/src/blob/new/.github/flightdeck.yaml) に基づき自動で作成しています。"
    );
    expect(body).not.toContain("<details>");
    expect(pullRequestBody({ ...input, included: { commits: [], total: 0 } })).not.toContain("<details>");
  });

  it("表の中の | を escape し、列を崩さない", () => {
    const body = pullRequestBody({ ...input, path: "a|b", baseBranch: "x|y" });
    expect(body).toContain("` a\\|b ` (base: ` x\\|y `)");
  });

  it("commit の件名を code span に入れ、mention や issue の link にしない", () => {
    const body = pullRequestBody({
      ...input,
      included: {
        commits: [
          { sha: "abcdef0123", subject: "fix @someone #1" },
          { sha: "1234567890", subject: "use `x`" },
        ],
        total: 2,
      },
    });
    expect(body).toContain("<summary>含まれるコミット（2 件）</summary>");
    expect(body).toContain("- [`abcdef0`](https://github.com/a/src/commit/abcdef0123) ` fix @someone #1 `");
    expect(body).toContain("- [`1234567`](https://github.com/a/src/commit/1234567890) `` use `x` ``");
  });

  it("` の連続が多い件名でも、例外にせず上限を超える行を省く", () => {
    const body = pullRequestBody({
      ...input,
      included: { commits: [{ sha: "abcdef0123", subject: "`a".repeat(200_000) }], total: 1 },
    });
    expect(body).toContain("- ほか 1 件（これより古いコミット）");
  });

  it("本文が上限を超えないよう、一覧の古い側を省き、省いた件数を先頭に示す", () => {
    const commits = Array.from({ length: 250 }, (_, index) => ({
      sha: String(index).padStart(40, "0"),
      subject: "x".repeat(1_000),
    }));
    const body = pullRequestBody({ ...input, included: { commits, total: 400 } });
    const lines = body.split("\n");
    const shown = lines.filter((line) => line.startsWith("- [")).length;

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(250);
    // 末尾（新しい側）から載せる
    expect(body).toContain(`/commit/${String(249).padStart(40, "0")})`);
    expect(body).not.toContain(`/commit/${String(0).padStart(40, "0")})`);
    expect(lines.find((line) => line.startsWith("- "))).toBe(
      `- ほか ${String(400 - shown)} 件（これより古いコミット）`
    );
  });

  it("withoutCommitList は、一覧のある本文を一覧のない本文と同じにする", () => {
    const included = { commits: [{ sha: "abcdef0123", subject: "a" }], total: 1 };
    expect(withoutCommitList(pullRequestBody({ ...input, included }))).toBe(pullRequestBody(input));
  });
});
