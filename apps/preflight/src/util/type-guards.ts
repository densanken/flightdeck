// Array も typeof は "object" になるため、record 判定では明示的に除外する
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// GitHub の ID と件数は 1 以上の整数で返る
// JSON の number は安全整数を超えると精度が落ちるため、範囲外も不正な shape として拒否する
export const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
