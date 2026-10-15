export type LogLevel = "debug" | "info" | "warn" | "error";

// 既定の record は event 以外の field を自由に持てる
export type LogRecord = { event: string } & Record<string, unknown>;

export interface Logger<R extends { event: string } = LogRecord> {
  log(level: LogLevel, record: R): void;
}

export interface LogSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_PATTERNS = [
  // GitHub token (ghp_, ghs_, gho_, ghu_, ghr_) と fine-grained personal access token (github_pat_)
  /\b(ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9_]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // Authorization header に載る Bearer, Bot, token 形式の値
  // 文中の "token could not ..." などを誤って隠さないよう、credential らしい長さの値だけを対象にする
  /(\b(?:Bearer|Bot|token)\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
  // PEM 形式の秘密鍵の本文
  /-----BEGIN[\s\S]*?END[^-]*-----/g,
  // token を含む Discord Webhook URL
  /(https:\/\/discord\.com\/api(?:\/v\d+)?\/webhooks\/[^/\s"]+\/)[^/\s"]+/g,
];

export const redactSecrets = (message: string): string => {
  let result = message;
  for (const pattern of SECRET_PATTERNS) {
    // SECRET_PATTERNS は module scope で共有する正規表現のため、走査前に lastIndex を 0 へ戻しておく
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && match.startsWith(prefix)) {
        return `${prefix}<redacted>`;
      }
      return "<redacted>";
    });
  }
  return result;
};

// JSON の escape を壊さないよう、JSON 化する前に文字列の値ごとに秘匿化する
const redactStringValue = (_key: string, value: unknown): unknown =>
  typeof value === "string" ? redactSecrets(value) : value;

// Workers Logs は JSON の message field を一覧の message 欄に出すため、event 名を message にも入れる
// field 名を固定したい app は、型引数に独自の record 型を渡す
export const createLogger = <R extends { event: string } = LogRecord>(
  minimumLevel: LogLevel = "info",
  sink: LogSink = console
): Logger<R> => ({
  log(level, record) {
    if (priorities[level] < priorities[minimumLevel]) return;
    // record が level や message を持っていても、logger が付ける値を優先する
    sink[level](JSON.stringify({ ...record, level, message: record.event }, redactStringValue));
  },
});
