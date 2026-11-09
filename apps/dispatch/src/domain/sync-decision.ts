interface PullRequestRef {
  number: number;
  baseBranch: string;
}

// 意図した base を向く最古の PR を残す
// なければ最古の PR を残し、他は重複として閉じる
export const planPullRequests = <T extends PullRequestRef>(
  pullRequests: T[],
  baseBranch: string
): { keep: T | undefined; duplicates: T[] } => {
  const sorted = [...pullRequests].sort((a, b) => a.number - b.number);
  const keep = sorted.find((pr) => pr.baseBranch === baseBranch) ?? sorted[0];

  return { keep, duplicates: sorted.filter((pr) => pr !== keep) };
};

// 管理 branch の HEAD commit が望ましい状態と完全に一致するときだけ true にする（no-op の判定）
// 呼び出し側は base の gitlink が source の SHA と違う場合だけ呼ぶので、変更ファイルがちょうど 1 件で
// その path の gitlink が source の SHA なら、差分は対象の gitlink だけになる
// 手動 commit があれば false になる（上に積んだ commit は親が base でなくなる）
// changedFiles は GitHub が数えられないと null になる
// null を false とすると、書き換えた branch の push で同期するたびに書き換え続けるため、一致とみなす
export const isUpToDate = (input: {
  baseSha: string;
  sourceSha: string;
  expectedMessage: string;
  branchCommit:
    { parentShas: string[]; message: string; gitlinkSha: string | undefined; changedFiles: number | null } | undefined;
}): boolean => {
  const commit = input.branchCommit;

  return (
    commit?.parentShas.length === 1 &&
    commit.parentShas[0] === input.baseSha &&
    commit.message === input.expectedMessage &&
    commit.gitlinkSha === input.sourceSha &&
    (commit.changedFiles ?? 1) === 1
  );
};
