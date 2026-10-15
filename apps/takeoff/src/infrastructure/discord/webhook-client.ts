import { escapeDiscordMarkdownLinkText, inlineCode } from "../../util/discord-markdown.js";
import { logger } from "../../util/logger.js";
import { truncateText } from "../../util/truncate.js";

import type { MergeAuditNotifier, MergeAuditPayload } from "../../usecase/merge/interface.js";

const EMBED_COLOR_SUCCESS = 0x57f287;

// Discord の embed field value は 1024 文字まで
// PR title は GitHub 上で任意長になりうるため、
// escape 前に切り詰めて field 超過による webhook 400（= 監査通知の欠落）を防ぐ
const MAX_PR_TITLE_LENGTH = 200;
const AUDIT_WEBHOOK_TIMEOUT_MS = 10_000;

export const notifyMergeAudit = async (webhookUrl: string, payload: MergeAuditPayload): Promise<void> => {
  const repoFullName = escapeDiscordMarkdownLinkText(payload.repo.fullName);
  const prTitle = escapeDiscordMarkdownLinkText(truncateText(payload.pullRequest.title, MAX_PR_TITLE_LENGTH));
  // Discord の user mention と timestamp 記法は、閲覧者の表示名とタイムゾーンで表示される
  // embed 内の mention は通知されない
  const mergedBy = `<@${payload.discordUserId}>`;
  const mergedAt = `<t:${String(Math.floor(payload.merge.mergedAt.getTime() / 1000))}:F>`;

  const embed = {
    title: "PR をマージしました",
    color: EMBED_COLOR_SUCCESS,
    fields: [
      { name: "Merged by", value: mergedBy, inline: false },
      { name: "Repository", value: `[${repoFullName}](${payload.repo.htmlUrl})`, inline: false },
      {
        name: "PR",
        value: `[${prTitle} (#${String(payload.pullRequest.number)})](${payload.pullRequest.htmlUrl})`,
        inline: false,
      },
      {
        name: "Branch",
        value: `${inlineCode(payload.pullRequest.headRef)} → ${inlineCode(payload.pullRequest.baseRef)}`,
        inline: true,
      },
      { name: "Head SHA", value: inlineCode(payload.pullRequest.headSha.slice(0, 7)), inline: true },
      { name: "Merge commit", value: inlineCode(payload.merge.commitSha.slice(0, 7)), inline: true },
      { name: "Merged at", value: mergedAt, inline: false },
    ],
  };

  // timeout がないと merge 成功後の waitUntil が実行期限（応答後最大 30 秒）まで占有され、
  // Discord への成功応答も遅れる
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [embed],
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(AUDIT_WEBHOOK_TIMEOUT_MS),
  });

  if (!response.ok) {
    logger.log("error", { event: "merge_audit_webhook_http_error", status: response.status });
  }
};

export class DiscordMergeAuditNotifier implements MergeAuditNotifier {
  constructor(private readonly webhookUrl: string) {}

  notifyMergeAudit(payload: MergeAuditPayload): Promise<void> {
    return notifyMergeAudit(this.webhookUrl, payload);
  }
}
