import * as v from "valibot";

export const OWNER_PATTERN = "[A-Za-z0-9-]+";

export const NAME_PATTERN = "[A-Za-z0-9._-]+";

// repo 名が . と .. だけの場合は除く
export const REPOSITORY_PATTERN = new RegExp(`^${OWNER_PATTERN}/(?!\\.\\.?$)${NAME_PATTERN}$`);

// JSON の number は安全整数を超えると精度が落ちるため、範囲外も拒否する
export const githubId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

export const commitSha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));

export const repositoryFullName = v.pipe(v.string(), v.regex(REPOSITORY_PATTERN));

// Valibot の object は配列も受け付けるため、設定の mapping を検証する前に除く
export const configObject = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value)
);
