// Discord embed へ埋め込むユーザー入力の escape
// リンク偽装（[ ] \）に加えて、改行による行構造の注入（別の見出し行の偽装など）と ` * _ ~ | の書式注入を無効化する
export const escapeDiscordMarkdownLinkText = (value: string): string =>
  value.replace(/[\r\n]+/g, " ").replace(/([\\`*_~|[\]])/g, "\\$1");

// inline code の中では escape が効かず ` で code が閉じるため、' に置き換える
export const inlineCode = (text: string): string => `\`${text.replaceAll("`", "'")}\``;

// 外部データ由来の URL を markdown link `[text](url)` の URL 部へ埋め込めるか検証する
// http/https 以外の scheme は拒否し、`)` による link 構文の打ち切りを防ぐため括弧を encode する
// 元の入力文字列ではなく URL parser が正規化した href を使う（制御文字の混入を防ぐ）
// 使えない URL は null を返す（呼び出し側はリンクにせずテキスト表示へ fallback する）
export const safeEmbedLinkUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
};
