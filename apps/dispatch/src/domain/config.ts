import {
  chooseConfig as chooseSharedConfig,
  ConfigError,
  parseConfigDocument,
  REPOSITORY_PATTERN,
} from "@flightdeck/rules";
import { z } from "zod";

import { DispatchError } from "../errors.js";

import type { ConfigFile } from "@flightdeck/rules";

export interface Target {
  repository: string;
  path: string;
  baseBranch?: string;
}

export const MAX_TARGETS = 20;

// eslint-disable-next-line no-control-regex -- 制御文字を検出するための正規表現
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

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

// 共有の設定エラーを Dispatch の設定エラーに変換する
const asDispatchError = <T>(read: () => T): T => {
  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigError) throw new DispatchError("config", error.message);
    throw error;
  }
};

// 存在する設定ファイルから、使う 1 つを選ぶ
// どちらもなければ undefined、両方あれば設定エラー
// 読めないファイル（null）を一部の設定や空の設定と見なすと、target の削除と取り違えるため、設定エラーにする
export const chooseConfig = (files: ConfigFile[]): { path: string; text: string } | undefined =>
  asDispatchError(() => chooseSharedConfig(files));

// 共有の設定ファイル（flightdeck.yml）の YAML を読み、dispatch の section を検査して target の一覧にする
// 他の app の section は読まないので、トップレベルの未知の key は無視する
// dispatch の key がなければ、Dispatch の設定はないものとして空の一覧を返す
export const parseConfig = (text: string): Target[] => {
  const raw = asDispatchError(() => parseConfigDocument(text));

  // 空のファイルは、Dispatch の設定がないものとして扱う
  if (raw === null || !("dispatch" in raw)) return [];

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
