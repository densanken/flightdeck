import { CONVENTIONAL_COMMITS_URL } from "@flightdeck/pr-title";

import {
  COMMIT_STATUS_DESCRIPTION_BYTE_BUDGET,
  commitStatusDescriptionByteLength,
  truncateCommitStatusDescription,
} from "./commit-status-description.js";

export interface TitleStatusMessage {
  description: string;
  /**
   * Details のリンク先
   * 利用者がタイトルを直す必要があるときだけ付ける
   */
  targetUrl?: string;
}

export const buildTitleFailureStatusMessage = (
  pullRequestNumbers: readonly [number, ...number[]]
): TitleStatusMessage => {
  const pullRequests = pullRequestNumbers.map((number) => `#${String(number)}`).join(", ");
  const completeDescription = `PR ${pullRequests} のタイトルを修正する必要があります`;
  const fallbackDescription = `PR #${String(pullRequestNumbers[0])} ほか ${String(pullRequestNumbers.length - 1)} 件のタイトルを修正する必要があります`;
  const description =
    commitStatusDescriptionByteLength(completeDescription) <= COMMIT_STATUS_DESCRIPTION_BYTE_BUDGET
      ? completeDescription
      : truncateCommitStatusDescription(fallbackDescription);
  return { description, targetUrl: CONVENTIONAL_COMMITS_URL };
};

/**
 * `PR Title` commit status に出す文言
 * この App は description を保守的に UTF-8 で 140 bytes 以内へ収める
 * markdown も使えないため、次に取るべき操作だけを書く
 * 形式の説明、使用できる type、修正例は PR コメント側に載せる
 */
export const TITLE_STATUS_MESSAGES = {
  pending: { description: "タイトルを検証しています" },
  success: { description: "タイトルに問題はありません" },
  draft: { description: "draft のため検証を保留しています" },
  wipTitle: { description: "作業中の接頭辞が付いているため検証を保留しています" },
  emptyHead: { description: "関連する open PR が見つかりませんでした" },
  supersededHead: { description: "PR の最新 commit ではありません" },
  failClosed: { description: "検証に失敗しました" },
} as const satisfies Record<string, TitleStatusMessage>;
