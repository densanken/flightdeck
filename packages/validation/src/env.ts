import * as v from "valibot";

import { githubId } from "./schema.js";

// 実行環境の設定が不足または不正な場合
export class ConfigurationError extends Error {
  constructor(
    readonly configKey: string,
    readonly reason: "missing" | "invalid"
  ) {
    super(reason === "missing" ? `Runtime configuration is missing: ${configKey}` : `Invalid ${configKey}`);
    this.name = "ConfigurationError";
  }
}

// Webhook secret は GitHub 側と同じ保存値で HMAC に使うため、存在判定だけ trim する
export const requiredString = (value: string | undefined, key: string): string => {
  if (!value?.trim()) throw new ConfigurationError(key, "missing");

  return value;
};

export const requiredId = (value: string | undefined, key: string): number => {
  const normalized = requiredString(value, key).trim();
  const result = v.safeParse(v.pipe(v.string(), v.regex(/^\d+$/), v.transform(Number), githubId), normalized);
  if (!result.success) {
    throw new ConfigurationError(key, "invalid");
  }

  return result.output;
};

export const requiredIdList = (value: string | undefined, key: string): number[] =>
  requiredString(value, key)
    .split(",")
    .map((item) => requiredId(item, key));

export const optionalPositiveInteger = (value: string | undefined, key: string, defaultValue: number): number =>
  value === undefined || value.trim() === "" ? defaultValue : requiredId(value, key);
