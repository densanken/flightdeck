import { MANAGED_BRANCH_PREFIX, splitRepository } from "@flightdeck/rules";

import { DispatchError } from "../errors.js";

const AUTOCLOSED_SUFFIX = " - autoclosed";
// GitHub の PR タイトルの上限
const MAX_TITLE_LENGTH = 256;

export const isManagedBranch = (branch: string): boolean => branch.startsWith(MANAGED_BRANCH_PREFIX);

// source の owner/repo をそのまま含めるので、branch 名から source を一意に戻せる
// repo 名が git の ref の component として使えない形（. で始まる、. か .lock で終わる、.. を含む）なら、書き込みの前に設定エラーにする
// owner は英数字と - だけなので、検査しない
export const managedBranchName = (source: string): string => {
  const name = splitRepository(source).name;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock") || name.includes("..")) {
    throw new DispatchError("config", `the source repository name cannot be used in a branch name: ${source}`);
  }

  return `${MANAGED_BRANCH_PREFIX}${source}`;
};

// PR title と commit message は同じ文字列にする
export const updateTitle = (source: string): string => `chore(submodule): update ${source}`;

// Dispatch が Close した PR の title か
export const isAutoclosed = (title: string): boolean => title.endsWith(AUTOCLOSED_SUFFIX);

// すでに付いていればそのまま
// 付けるときは、タイトルの上限に収まるよう元のタイトルを切り詰める
export const withAutoclosedSuffix = (title: string): string => {
  if (isAutoclosed(title)) return title;

  let kept = title.slice(0, MAX_TITLE_LENGTH - AUTOCLOSED_SUFFIX.length);
  // 切り口が surrogate pair の途中なら、その文字を落とす
  if (/[\uD800-\uDBFF]$/.test(kept) && kept.length < title.length) kept = kept.slice(0, -1);

  return `${kept}${AUTOCLOSED_SUFFIX}`;
};
