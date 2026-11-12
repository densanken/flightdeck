import { parseDocument } from "yaml";
import { z } from "zod";

// repository 内の設定ファイル
// 切り詰められたファイルやバイナリの本文は null
export interface ConfigFile {
  path: string;
  text: string | null;
}

export class ConfigError extends Error {
  constructor(
    readonly code: "config_both_files" | "config_unreadable" | "config_too_large" | "config_invalid" | "config_alias",
    message: string
  ) {
    super(message);
  }
}

export const CONFIG_PATHS = { yml: ".github/flightdeck.yml", yaml: ".github/flightdeck.yaml" };

// 具体値は実装時の判断で、通常の設定を十分に収める範囲に留める
const MAX_CONFIG_BYTES = 32 * 1024;

// 存在する設定ファイルから、使う 1 つを選ぶ
// どちらもなければ undefined、両方あれば設定エラー
// 読めないファイル（null）を一部の設定や空の設定と見なすと、設定の削除と取り違えるため、設定エラーにする
export const chooseConfig = (files: ConfigFile[]): { path: string; text: string } | undefined => {
  if (files.length > 1) throw new ConfigError("config_both_files", "both flightdeck.yml and flightdeck.yaml exist");

  const file = files[0];
  if (file === undefined) return undefined;
  if (file.text === null) throw new ConfigError("config_unreadable", "flightdeck config cannot be read");

  return { path: file.path, text: file.text };
};

// YAML の大きさ、警告とエラー、alias の規則はファイル全体に適用する
export const parseConfigDocument = (text: string): Record<string, unknown> | null => {
  if (new TextEncoder().encode(text).byteLength > MAX_CONFIG_BYTES) {
    throw new ConfigError("config_too_large", "flightdeck config is too large");
  }

  // 未知の tag は警告だけで文字列になるため、警告もエラーとして扱う
  const document = parseDocument(text);
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new ConfigError("config_invalid", "flightdeck config is not valid YAML");
  }

  const raw: unknown = (() => {
    try {
      return document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch {
      throw new ConfigError("config_alias", "flightdeck config must not use aliases");
    }
  })();

  // 空のファイルには設定がない
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config_invalid", "flightdeck config must be a mapping");
  }

  return raw as Record<string, unknown>;
};

const autopilotSchema = z.strictObject({ "renovate-stale": z.boolean().nullish() });

export const parseAutopilotConfig = (text: string): { renovateStale: boolean } => {
  const raw = parseConfigDocument(text);
  const parsed = autopilotSchema.nullish().safeParse(raw?.autopilot);
  if (!parsed.success) throw new ConfigError("config_invalid", "flightdeck config is invalid at autopilot");

  return { renovateStale: parsed.data?.["renovate-stale"] ?? true };
};
