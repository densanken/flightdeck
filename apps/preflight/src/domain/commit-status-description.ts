// GitHub は commit status の description が長すぎると 422 を返すが、
// 非 ASCII をどの単位で数えるかは公開されていない
// どの数え方でも安全側になるよう、この App が送る description の上限を UTF-8 で 140 bytes とする
export const COMMIT_STATUS_DESCRIPTION_BYTE_BUDGET = 140;

const encoder = new TextEncoder();

export const commitStatusDescriptionByteLength = (description: string): number => encoder.encode(description).length;

// 上限を超える分を落とす
// code point 単位で進めるため surrogate pair は分割しない
export const truncateCommitStatusDescription = (description: string): string => {
  let bytes = 0;
  let result = "";

  for (const character of description) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > COMMIT_STATUS_DESCRIPTION_BYTE_BUDGET) break;

    result += character;
    bytes += characterBytes;
  }

  return result;
};
