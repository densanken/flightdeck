import { describe, expect, it } from "vitest";

import { parseGitHubPrUrl, parseGitHubRepoUrl } from "./parse-github-url.js";

describe("parseGitHubRepoUrl", () => {
  it("owner/repo を抽出できる", () => {
    expect(parseGitHubRepoUrl("https://github.com/my-org/my-repo")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("末尾スラッシュ付きの URL を処理できる", () => {
    expect(parseGitHubRepoUrl("https://github.com/my-org/my-repo/")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("サブパス付きの URL から owner/repo を抽出できる", () => {
    expect(parseGitHubRepoUrl("https://github.com/my-org/my-repo/pull/123")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("query 付きの URL から owner/repo を抽出できる", () => {
    expect(parseGitHubRepoUrl("https://github.com/my-org/my-repo?tab=readme")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("fragment 付きの URL から owner/repo を抽出できる", () => {
    expect(parseGitHubRepoUrl("https://github.com/my-org/my-repo#readme")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("owner のみの URL には null を返す", () => {
    expect(parseGitHubRepoUrl("https://github.com/my-org")).toBeNull();
  });

  it("GitHub 以外の URL には null を返す", () => {
    expect(parseGitHubRepoUrl("https://gitlab.com/my-org/my-repo")).toBeNull();
  });

  it("空文字列には null を返す", () => {
    expect(parseGitHubRepoUrl("")).toBeNull();
  });

  it("URL でない文字列には null を返す", () => {
    expect(parseGitHubRepoUrl("my-org/my-repo")).toBeNull();
  });

  it("https://github.com/ のみには null を返す", () => {
    expect(parseGitHubRepoUrl("https://github.com/")).toBeNull();
  });

  it("非 HTTPS の GitHub URL には null を返す", () => {
    expect(parseGitHubRepoUrl("http://github.com/owner/repo")).toBeNull();
  });
});

describe("parseGitHubPrUrl", () => {
  it("PR URL から owner/repo/number を抽出できる", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/42")).toEqual({
      owner: "my-org",
      repo: "my-repo",
      number: 42,
    });
  });

  it("/files サフィックス付きの PR URL を処理できる", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/123/files")).toEqual({
      owner: "my-org",
      repo: "my-repo",
      number: 123,
    });
  });

  it("/commits サフィックス付きの PR URL を処理できる", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/99/commits")).toEqual({
      owner: "my-org",
      repo: "my-repo",
      number: 99,
    });
  });

  it("末尾スラッシュ付きの PR URL を処理できる", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/7/")).toEqual({
      owner: "my-org",
      repo: "my-repo",
      number: 7,
    });
  });

  it("query 付きの PR URL を処理できる", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/5?tab=files")).toEqual({
      owner: "my-org",
      repo: "my-repo",
      number: 5,
    });
  });

  it("fragment 付きの PR URL を処理できる", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/5#issuecomment-1")).toEqual({
      owner: "my-org",
      repo: "my-repo",
      number: 5,
    });
  });

  it("リポジトリ URL（/pull なし）には null を返す", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo")).toBeNull();
  });

  it("/pull/ の後に番号がない場合は null を返す", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/")).toBeNull();
  });

  it("/pull/ の後が数字以外の場合は null を返す", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/abc")).toBeNull();
  });

  it("GitHub 以外の URL には null を返す", () => {
    expect(parseGitHubPrUrl("https://gitlab.com/my-org/my-repo/pull/1")).toBeNull();
  });

  it("空文字列には null を返す", () => {
    expect(parseGitHubPrUrl("")).toBeNull();
  });

  it("不正な URL には null を返す", () => {
    expect(parseGitHubPrUrl("not-a-url")).toBeNull();
  });

  it("PR 番号が 0 の場合は null を返す", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/0")).toBeNull();
  });

  it("PR 番号が負の場合は null を返す", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/-1")).toBeNull();
  });

  it("PR 番号が小数の場合は null を返す", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/1.5")).toBeNull();
  });

  it("owner や repo の名前が pull でも、owner/repo の直後の segment だけを PR の位置として読む", () => {
    expect(parseGitHubPrUrl("https://github.com/org/pull/pull/5")).toEqual({ owner: "org", repo: "pull", number: 5 });
    expect(parseGitHubPrUrl("https://github.com/pull/123/pull/5")).toEqual({ owner: "pull", repo: "123", number: 5 });
    expect(parseGitHubPrUrl("https://github.com/pull/123")).toBeNull();
    expect(parseGitHubPrUrl("https://github.com/org/repo/tree/pull/5")).toBeNull();
  });

  it("10 進数以外の表記や safe integer を超える PR 番号には null を返す", () => {
    expect(parseGitHubPrUrl("https://github.com/my-org/my-repo/pull/9007199254740991")?.number).toBe(9007199254740991);
    for (const value of ["0x10", "5e2", "9007199254740992"]) {
      expect(parseGitHubPrUrl(`https://github.com/my-org/my-repo/pull/${value}`)).toBeNull();
    }
  });
});
