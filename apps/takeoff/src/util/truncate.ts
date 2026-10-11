const segmenter = new Intl.Segmenter();

// UTF-16 の長さで maxLength 以内に収め、超える分は末尾を … にする
// 固定位置で切ると絵文字のサロゲートペアや結合文字列が分断され、Discord が不正な文字列として拒否するため、書記素の境界で切る
export const truncateText = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  // … の分を空けた末尾の位置を含む書記素の先頭で切る
  const index = segmenter.segment(value).containing(maxLength - 1)?.index ?? maxLength - 1;
  return `${value.slice(0, index)}…`;
};
