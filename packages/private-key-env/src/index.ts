import { createPrivateKey, randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { KeyObject } from "node:crypto";

const DEFAULT_ENV_PATH = ".env";

// GitHub がダウンロードさせる秘密鍵は PKCS#1 が既定のため、PKCS#1, PKCS#8 のどちらを渡されても
// ここで常に PKCS#8 PEM へ正規化してから .env へ書き、読み取り側で形式ごとに分岐せずに済むようにする
const normalizeToPkcs8Pem = (privateKeyPem: string, privateKeyPath: string): string => {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    // 秘密鍵の内容を error message に含めない
    throw new Error(`${privateKeyPath} is not a valid PEM private key (expected PKCS#1 or PKCS#8)`);
  }
  // RSA 以外の秘密鍵は正規化に成功しても runtime の RS256 署名で初めて失敗するため、.env へ書く前に弾く
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error(`${privateKeyPath} is not an RSA private key (GitHub App private keys are RSA)`);
  }
  return privateKey.export({ type: "pkcs8", format: "pem" });
};

export const escapeEnvValue = (value: string): string =>
  value.replace(/\r\n/g, "\n").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

interface EnvAssignmentRange {
  start: number;
  end: number;
}

const findLineEnd = (content: string, start: number): number => {
  const lineFeed = content.indexOf("\n", start);
  return lineFeed === -1 ? content.length : lineFeed;
};

const findClosingQuote = (content: string, start: number, quote: string): number | null => {
  const closingQuote = content.indexOf(quote, start);
  return closingQuote === -1 ? null : closingQuote;
};

const findEnvAssignments = (content: string, key: string): EnvAssignmentRange[] => {
  const assignments: EnvAssignmentRange[] = [];
  const assignmentPrefix = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*/;
  let recordStart = 0;

  while (recordStart < content.length) {
    const prefix = assignmentPrefix.exec(content.slice(recordStart));
    let recordEnd = findLineEnd(content, recordStart);
    if (prefix) {
      const valueStart = recordStart + prefix[0].length;
      const quote = content[valueStart];
      if (quote === '"' || quote === "'" || quote === "`") {
        const closingQuote = findClosingQuote(content, valueStart + 1, quote);
        recordEnd = closingQuote === null ? content.length : findLineEnd(content, closingQuote + 1);
      }
      if (prefix[1] === key) assignments.push({ start: recordStart, end: recordEnd });
    }

    recordStart = recordEnd === content.length ? content.length : recordEnd + 1;
  }

  return assignments;
};

export const setEnvVar = (content: string, key: string, value: string): string => {
  const line = `${key}="${escapeEnvValue(value)}"`;
  // Node の dotenv parser と同様に、行頭の空白、export prefix、= 前後の空白を assignment として扱い、
  // 複数行の quoted value 内に現れる key らしい文字列は assignment として数えない
  const assignments = findEnvAssignments(content, key);
  if (assignments.length > 1) {
    throw new Error(`Duplicate ${key} assignments found in environment file`);
  }
  const assignment = assignments[0];
  if (assignment) return `${content.slice(0, assignment.start)}${line}${content.slice(assignment.end)}`;

  const separator = content.endsWith("\n") || content.length === 0 ? "" : "\n";
  return `${content}${separator}${line}\n`;
};

export const createTemporaryEnvPath = (envPath: string, uniqueId: string = randomUUID()): string =>
  join(dirname(envPath), `${basename(envPath)}.${uniqueId}.tmp`);

export const parseArgs = (args: string[]): { privateKeyPath: string | undefined; envPath: string } => {
  // pnpm は `pnpm run <script> -- ...` の区切りを argv の先頭へ残す
  // 先頭の 1 個だけ pnpm の区切りとして取り除き、以降は通常の CLI 引数として解析する
  const cliArgs = args[0] === "--" ? args.slice(1) : args;

  let privateKeyPath: string | undefined;
  let envPath = DEFAULT_ENV_PATH;
  // 2 個目以降の `--` は POSIX の慣習どおり option の終端として扱い、以降は path として読む
  let optionsTerminated = false;
  for (let index = 0; index < cliArgs.length; index += 1) {
    const argument = cliArgs[index];
    if (argument === undefined) continue;
    if (!optionsTerminated && argument === "--") {
      optionsTerminated = true;
    } else if (!optionsTerminated && argument === "--env-file") {
      const value = cliArgs[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--env-file requires a path");
      envPath = value;
      index += 1;
    } else if (!optionsTerminated && argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (privateKeyPath === undefined) {
      privateKeyPath = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  return { privateKeyPath, envPath };
};

// key は .env に書く環境変数名で、app ごとに異なる（例: preflight は GITHUB_PRIVATE_KEY、takeoff は GITHUB_APP_PRIVATE_KEY）
export const setGitHubPrivateKey = (key: string, privateKeyPath: string, envPath = DEFAULT_ENV_PATH): void => {
  const privateKey = normalizeToPkcs8Pem(readFileSync(privateKeyPath, "utf8"), privateKeyPath);
  const envFile = readFileSync(envPath, "utf8");
  const temporaryPath = createTemporaryEnvPath(envPath);
  try {
    writeFileSync(temporaryPath, setEnvVar(envFile, key, privateKey), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, envPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 一時 file が存在しないか、すでに rename 済みの場合がある
    }
    throw error;
  }
};

// moduleUrl は呼び出し側 script 自身の import.meta.url を渡す
// pnpm 経由で直接実行された script だけで CLI を起動し、他 module や test からの import では何もしない
export const runSetGitHubPrivateKeyCli = (key: string, moduleUrl: string): void => {
  const mainModuleUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
  if (moduleUrl !== mainModuleUrl) return;

  try {
    const { privateKeyPath, envPath } = parseArgs(process.argv.slice(2));
    if (!privateKeyPath) {
      // --env-file は options 終端の `--` より前に置く必要があるため、引数の順序どおりに示す
      console.error(
        "Usage: set-github-private-key [--env-file <path>] <path/to/github-app-private-key.pem>\n" +
          "  via pnpm: pnpm run set-github-private-key -- [--env-file <path>] <path/to/github-app-private-key.pem>"
      );
      process.exitCode = 1;
    } else {
      setGitHubPrivateKey(key, privateKeyPath, envPath);
      console.log(`Updated ${envPath}: ${key}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to update GitHub private key");
    process.exitCode = 1;
  }
};
