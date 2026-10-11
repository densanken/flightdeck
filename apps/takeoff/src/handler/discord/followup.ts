import { MAX_EMBED_DESCRIPTION_LENGTH } from "./constants.js";
import { EmbedColor } from "./interaction-response.js";
import { truncateText } from "../../util/truncate.js";

import type { APIEmbed, APIMessageTopLevelComponent } from "discord-api-types/v10";

export const FOLLOWUP_TIMEOUT_MS = 10_000;

// 超えると API が 400 を返し、利用者には deferred 表示だけが残るため、送信前に必ず収める
// markdown link を途中で切らないよう、上限内の最後の改行で切る
const clampEmbedDescription = (embed: APIEmbed): APIEmbed => {
  if (!embed.description || embed.description.length <= MAX_EMBED_DESCRIPTION_LENGTH) {
    return embed;
  }
  const head = embed.description.slice(0, MAX_EMBED_DESCRIPTION_LENGTH - 2);
  const lastNewline = head.lastIndexOf("\n");
  // 改行が無い場合は固定位置で切ると絵文字を分断しうるため、書記素の境界で切る
  const description =
    lastNewline > 0
      ? `${head.slice(0, lastNewline)}\n…`
      : truncateText(embed.description, MAX_EMBED_DESCRIPTION_LENGTH);
  return { ...embed, description };
};

export const editDeferredResponse = async (
  applicationId: string,
  interactionToken: string,
  embed: APIEmbed,
  components?: APIMessageTopLevelComponent[]
): Promise<void> => {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  try {
    // timeout がないと waitUntil が Cloudflare の実行期限（応答後最大 30 秒）まで占有される
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "", embeds: [clampEmbedDescription(embed)], components }),
      signal: AbortSignal.timeout(FOLLOWUP_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("discord_followup_http_error", { status: response.status });
    }
  } catch (error) {
    // fetch の例外 message には request URL（interaction token を含む）が乗ることがあるため、
    // message は記録せず error の name だけを記録する
    console.error("discord_followup_request_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
};

export const editDeferredWithError = async (
  applicationId: string,
  interactionToken: string,
  message: string
): Promise<void> => {
  await editDeferredResponse(applicationId, interactionToken, {
    title: "エラー",
    description: message,
    color: EmbedColor.Error,
  });
};
