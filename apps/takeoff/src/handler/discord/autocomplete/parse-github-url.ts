import { toPrNumber } from "../helpers.js";

export interface ParsedRepoUrl {
  owner: string;
  repo: string;
}

export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

const GITHUB_PREFIX = "https://github.com/";

// query や fragment を含む PR URL でも番号を取り出せるよう、最初の ? か # 以降を捨てて path だけを解析する
const stripQueryAndFragment = (input: string): string => input.split(/[?#]/)[0] ?? input;

export const parseGitHubRepoUrl = (input: string): ParsedRepoUrl | null => {
  const cleaned = stripQueryAndFragment(input);
  if (!cleaned.startsWith(GITHUB_PREFIX)) return null;

  const path = cleaned.slice(GITHUB_PREFIX.length);
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, repo] = segments;
  if (!owner || !repo) return null;

  return { owner, repo };
};

export const parseGitHubPrUrl = (input: string): ParsedPrUrl | null => {
  const repoUrl = parseGitHubRepoUrl(input);
  if (!repoUrl) return null;

  // PR URL は owner/repo/pull/{number} の形なので、owner と repo の直後だけを見る
  // パス全体から "pull" を探すと、owner や repo の名前が pull のときに別の segment を番号として読む
  const path = stripQueryAndFragment(input).slice(GITHUB_PREFIX.length);
  const [, , kind, numberStr] = path.split("/").filter(Boolean);
  if (kind !== "pull" || numberStr === undefined) return null;

  const number = toPrNumber(numberStr);
  if (number === null) return null;

  return { owner: repoUrl.owner, repo: repoUrl.repo, number };
};
