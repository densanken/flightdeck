import { NAME_PATTERN, OWNER_PATTERN, REPOSITORY_PATTERN } from "@flightdeck/validation";

export const MANAGED_BRANCH_PREFIX = "flightdeck-dispatch/";

const RENOVATE_BRANCH_PREFIX = "renovate/";

// Dispatch と Renovate が作る PR の branch か
// webhook の段階で、評価の対象外の PR を GitHub を呼ばずに見送るために使う
export const isAutomationBranch = (branch: string): boolean =>
  branch.startsWith(MANAGED_BRANCH_PREFIX) || branch.startsWith(RENOVATE_BRANCH_PREFIX);

// 管理 branch 名から source の owner/repo を戻す
// owner/repo の形でなければ undefined
export const sourceOf = (branch: string): string | undefined => {
  const source = branch.startsWith(MANAGED_BRANCH_PREFIX) ? branch.slice(MANAGED_BRANCH_PREFIX.length) : "";

  return REPOSITORY_PATTERN.test(source) ? source : undefined;
};

// HTTPS、scp 形式の SSH、ssh:// 形式の GitHub URL を受け付ける
// repo 名は最短一致にし、末尾の .git を名前に含めない
const GITHUB_URL_PATTERN = new RegExp(
  `^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${OWNER_PATTERN}/${NAME_PATTERN}?)(?:\\.git)?/?$`,
  "i"
);

// 相対 URL や GitHub 以外の host は null、小文字の owner/repo に正規化する
// repo 名の . と .. は REPOSITORY_PATTERN で除く
export const normalizeGitHubUrl = (url: string): string | null => {
  const name = GITHUB_URL_PATTERN.exec(url.trim())?.[1]?.toLowerCase();

  return name && REPOSITORY_PATTERN.test(name) ? name : null;
};
