import { NAME_PATTERN, OWNER_PATTERN, REPOSITORY_PATTERN } from "./config.js";

// GitHub が .gitmodules から読み取った submodule
// url は GitHub の gitUrl
export interface Submodule {
  path: string;
  url: string;
}

// https、scp 形式の ssh、ssh:// 形式の GitHub の URL
// repo 名は最短一致（+?）にし、末尾の .git を名前に含めない
const GITHUB_URL_PATTERN = new RegExp(
  `^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${OWNER_PATTERN}/${NAME_PATTERN}?)(?:\\.git)?/?$`,
  "i"
);

// 対応する形式以外（相対 URL や GitHub 以外の host）は null を返し、小文字の owner/repo に正規化する
// repo 名の . と .. は REPOSITORY_PATTERN で除く
export const normalizeGitHubUrl = (url: string): string | null => {
  const name = GITHUB_URL_PATTERN.exec(url.trim())?.[1]?.toLowerCase();

  return name && REPOSITORY_PATTERN.test(name) ? name : null;
};
