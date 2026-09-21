import { describe, expect, it } from "vitest";

import { buildTitleFailureStatusMessage, TITLE_STATUS_MESSAGES } from "./title-status-message.js";

import type { TitleStatusMessage } from "./title-status-message.js";

// GitHub の上限
// 超えると setPullRequestTitleStatus が投稿前に throw し、その delivery は retry を使い切るまで決定的に失敗する
const MAX_DESCRIPTION_LENGTH = 140;

const messages = Object.entries(TITLE_STATUS_MESSAGES) as [string, TitleStatusMessage][];

describe("TITLE_STATUS_MESSAGES", () => {
  it.each(messages)("%s の description は GitHub の上限に収まる", (_name, message) => {
    // UTF-16 code unit と UTF-8 byte の両方で上限に収まることを見る
    expect(message.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(new TextEncoder().encode(message.description).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(message.description.trim()).not.toBe("");
  });

  it("利用者がタイトルを直す必要がある文言にだけ target_url を付ける", () => {
    const withTargetUrl = messages.filter(([, message]) => message.targetUrl !== undefined).map(([name]) => name);

    // 作業中の接頭辞は保留であって修正の要求ではないため、target_url は state が failure の文言だけに付く
    expect(withTargetUrl).toEqual([]);
    expect(buildTitleFailureStatusMessage([123])).toEqual({
      description: "PR #123 のタイトルを修正する必要があります",
      targetUrl: "https://www.conventionalcommits.org/ja/v1.0.0/",
    });
  });

  it("複数の PR で修正が必要なら番号を列挙する", () => {
    expect(buildTitleFailureStatusMessage([7, 8, 12]).description).toBe(
      "PR #7, #8, #12 のタイトルを修正する必要があります"
    );
  });

  it("PR 番号の列挙が GitHub の上限を超える場合は先頭と残件数を表示する", () => {
    const pullRequestNumbers = Array.from({ length: 50 }, (_, index) => index + 1);
    const [first, ...rest] = pullRequestNumbers;
    if (first === undefined) throw new Error("Expected test pull request numbers");
    const message = buildTitleFailureStatusMessage([first, ...rest]);

    expect(message.description).toBe("PR #1 ほか 49 件のタイトルを修正する必要があります");
    expect(message.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(new TextEncoder().encode(message.description).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });
});
