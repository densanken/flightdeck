import { parseDocument } from "yaml";
import { z } from "zod";

import { DispatchError } from "../errors.js";

// 設定ファイルの repository 内の path と本文
// 読めないファイル（切り詰められた、バイナリ）の本文は null
export interface ConfigFile {
  path: string;
  text: string | null;
}

export interface Target {
  repository: string;
  path: string;
  baseBranch?: string;
}

// 設定は共有の flightdeck.yml か flightdeck.yaml に書く
export const CONFIG_PATHS = { yml: ".github/flightdeck.yml", yaml: ".github/flightdeck.yaml" };

// 具体値は実装時の判断で、通常の設定を十分に収める範囲に留める
const MAX_CONFIG_BYTES = 32 * 1024;
export const MAX_TARGETS = 20;

// eslint-disable-next-line no-control-regex -- 制御文字を検出するための正規表現
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
export const OWNER_PATTERN = "[A-Za-z0-9-]+";
export const NAME_PATTERN = "[A-Za-z0-9._-]+";
// repo 名が . と .. だけの場合は除く
export const REPOSITORY_PATTERN = new RegExp(`^${OWNER_PATTERN}/(?!\\.\\.?$)${NAME_PATTERN}$`);

// owner/repo 形式の名前を分ける
export const splitRepository = (repository: string): { owner: string; name: string } => {
  const [owner = "", name = ""] = repository.split("/");
  return { owner, name };
};

const isSafePath = (path: string): boolean =>
  !CONTROL_CHARACTER.test(path) &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

// dispatch の中の未知の項目（baseBranch や base_branch を含む）は strictObject で拒否する
const dispatchSchema = z.strictObject({
  targets: z
    .array(
      z.strictObject({
        repository: z.string().regex(REPOSITORY_PATTERN),
        // 書き間違えやすい先頭と末尾の / は 1 つずつ取り除いてから検査する
        path: z
          .string()
          .transform((path) => path.replace(/^\/|\/$/g, ""))
          .refine(isSafePath),
        "base-branch": z.string().refine(isSafePath).optional(),
      })
    )
    .max(MAX_TARGETS),
});

// 存在する設定ファイルから、使う 1 つを選ぶ
// どちらもなければ undefined、両方あれば設定エラー
// 読めないファイル（null）を一部の設定や空の設定と見なすと、target の削除と取り違えるため、設定エラーにする
export const chooseConfig = (files: ConfigFile[]): { path: string; text: string } | undefined => {
  if (files.length > 1) throw new DispatchError("config", "both flightdeck.yml and flightdeck.yaml exist");

  const file = files[0];
  if (file === undefined) return undefined;
  if (file.text === null) throw new DispatchError("config", "flightdeck config cannot be read");

  return { path: file.path, text: file.text };
};

// 共有の設定ファイル（flightdeck.yml）の YAML を読み、dispatch の section を検査して target の一覧にする
// 他の app の section は読まないので、トップレベルの未知の key は無視する
// dispatch の key がなければ、Dispatch の設定はないものとして空の一覧を返す
// YAML の規則（エラーと警告の拒否、alias の禁止、大きさの上限）はファイル全体にかかる
// 未知の tag は警告だけで文字列になるため、警告もエラーとして扱い、alias は使わせない
export const parseConfig = (text: string): Target[] => {
  if (new TextEncoder().encode(text).byteLength > MAX_CONFIG_BYTES) {
    throw new DispatchError("config", "flightdeck config is too large");
  }

  const document = parseDocument(text);
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new DispatchError("config", "flightdeck config is not valid YAML");
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new DispatchError("config", "flightdeck config must not use aliases");
  }

  // 空のファイルは、Dispatch の設定がないものとして扱う
  if (raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DispatchError("config", "flightdeck config must be a mapping");
  }

  if (!("dispatch" in raw)) return [];

  const parsed = dispatchSchema.safeParse(raw.dispatch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DispatchError("config", `flightdeck config is invalid at dispatch.${issue?.path.join(".") ?? ""}`);
  }

  const targets = parsed.data.targets.map((target): Target => ({
    repository: target.repository,
    path: target.path,
    baseBranch: target["base-branch"],
  }));

  const seen = new Set<string>();
  for (const target of targets) {
    const key = target.repository.toLowerCase();
    if (seen.has(key))
      throw new DispatchError("config", `flightdeck config has duplicate target: ${target.repository}`);
    seen.add(key);
  }

  return targets;
};
