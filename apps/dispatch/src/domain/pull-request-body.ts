// GitHub の PR 本文の上限は 65,536 文字
// commit の一覧はこの長さに収まる分だけ、新しい側から載せる（一覧を囲む行と残りの件数の行の分を、上限との差で残す）
const BODY_BUDGET = 60_000;
const GITHUB_ORIGIN = "https://github.com";
const DISPATCH_URL = `${GITHUB_ORIGIN}/densanken/flightdeck/tree/main/apps/dispatch`;

// source の更新に含まれる commit
export interface IncludedCommits {
  // 古い順
  commits: { sha: string; subject: string }[];
  // commits に入りきらない分を含む総数
  total: number;
}

// GFM の表では、code span の中の | でも列が分かれるため、escape する
const tableCell = (text: string): string => text.replaceAll("|", "\\|");

const commitLink = (repository: string, sha: string): string =>
  `[\`${sha.slice(0, 7)}\`](${GITHUB_ORIGIN}/${repository}/commit/${sha})`;

// 中の ` より長い区切りで囲む
// commit の件名も code span に入れ、parent の PR で mention や issue の link にならないようにする
// 件名が長くても引数の上限に当たらないよう、最長の連続は spread せずに求める
const codeSpan = (text: string): string => {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);

  return `${fence} ${text} ${fence}`;
};

export const pullRequestBody = (input: {
  source: string;
  sourceBranch: string;
  sourceSha: string;
  path: string;
  baseBranch: string;
  previousSha: string;
  // target を読んだ設定ファイルの path
  configPath: string;
  // 比べられなければ undefined
  included: IncludedCommits | undefined;
}): string => {
  const { source, sourceSha, previousSha } = input;

  const summary = [
    `submodule ${codeSpan(input.path)} を \`${source}\` と同期します。`,
    "",
    // GFM の表は header 行を省けないため、項目名を header にした横向きの表にする
    "| Source | Target | 変更 |",
    "| --- | --- | --- |",
    `| [${source}](${GITHUB_ORIGIN}/${source}) (${tableCell(codeSpan(input.sourceBranch))}) | ${tableCell(codeSpan(input.path))} (base: ${tableCell(codeSpan(input.baseBranch))}) | ${commitLink(source, previousSha)} → ${commitLink(source, sourceSha)}（[差分](${GITHUB_ORIGIN}/${source}/compare/${previousSha}...${sourceSha})） |`,
    "",
  ];

  const note = [
    "> [!NOTE]",
    `> この PR は [flightdeck dispatch](${DISPATCH_URL}) が [${source} の設定](${GITHUB_ORIGIN}/${source}/blob/${sourceSha}/${input.configPath}) に基づき自動で作成しています。`,
    "> ブランチへのコミットは次回同期時に上書きされます。",
  ];

  const withoutCommits = [...summary, ...note].join("\n");
  if (!input.included || input.included.total === 0) return withoutCommits;

  // 新しい commit から載せ、上限に達したら古い側を省く（GitHub の compare も、新しい側の commit だけを返す）
  const lines: string[] = [];
  let length = withoutCommits.length;
  for (const commit of [...input.included.commits].reverse()) {
    const line = `- ${commitLink(source, commit.sha)} ${codeSpan(commit.subject)}`;
    if (length + line.length + 1 > BODY_BUDGET) break;
    lines.unshift(line);
    length += line.length + 1;
  }

  const rest = input.included.total - lines.length;

  return [
    ...summary,
    "<details>",
    `<summary>含まれるコミット（${String(input.included.total)} 件）</summary>`,
    "",
    ...(rest > 0 ? [`- ほか ${String(rest)} 件（これより古いコミット）`] : []),
    ...lines,
    "",
    "</details>",
    "",
    ...note,
  ].join("\n");
};

// 本文から commit の一覧（<details> の block）を除く
// 一覧を取得できなかった同期で、既存の本文の一覧以外が今の状態と同じか比べるために使う
export const withoutCommitList = (body: string): string => body.replace(/<details>\n[\s\S]*?\n<\/details>\n\n/, "");
