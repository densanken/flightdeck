import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTemporaryEnvPath,
  escapeEnvValue,
  parseArgs,
  runSetGitHubPrivateKeyCli,
  setEnvVar,
  setGitHubPrivateKey,
} from "./index.js";

// このテストでは preflight/takeoff 固有の環境変数名に依存しない汎用の key 名を使う
const KEY = "PRIVATE_KEY";

const temporaryDirectories: string[] = [];

const readEnvFileWithNode = (envPath: string, key: string): string => {
  const subprocessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== key));
  return execFileSync(
    process.execPath,
    ["--env-file", envPath, "--eval", `process.stdout.write(process.env[${JSON.stringify(key)}] ?? "")`],
    { encoding: "utf8", env: subprocessEnv }
  );
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("set-github-private-key", () => {
  // test 用の使い捨ての鍵
  // 実在の秘密鍵は hardcode しない
  let pkcs1Pem: string;
  let pkcs8Pem: string;

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" });
    pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" });
  });

  it("PEM を .env 向けの 1 行の値へ変換する", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----\n";
    expect(escapeEnvValue(pem)).toBe("-----BEGIN PRIVATE KEY-----\\nabc\\ndef\\n-----END PRIVATE KEY-----");
  });

  it("既存の key だけを差し替える", () => {
    const result = setEnvVar(`GITHUB_APP_ID=123\n${KEY}=\nGITHUB_WEBHOOK_SECRET=secret\n`, KEY, "a\nb");
    expect(result).toBe(`GITHUB_APP_ID=123\n${KEY}="a\\nb"\nGITHUB_WEBHOOK_SECRET=secret\n`);
  });

  it("key がなければ末尾へ追加する", () => {
    expect(setEnvVar("GITHUB_APP_ID=123", KEY, "a\nb")).toBe(`GITHUB_APP_ID=123\n${KEY}="a\\nb"\n`);
  });

  it("quoted value を含む重複 key を拒否する", () => {
    expect(() => setEnvVar(`${KEY}="old"\nGITHUB_APP_ID=123\n${KEY}=older\n`, KEY, "new")).toThrow(
      `Duplicate ${KEY} assignments`
    );
  });

  it("comment、別 key、値内の文字列を assignment として誤検出しない", () => {
    const original = [
      `  # export ${KEY} = commented`,
      `${KEY}_SUFFIX=other-key`,
      `OTHER_VALUE="contains export ${KEY} = text"`,
      'OTHER_MULTILINE="first line',
      `${KEY}=inside-multiline-value`,
      'last line"',
      "OTHER_BACKTICK=`first line",
      `${KEY}=inside-backtick-value`,
      "last line`",
      "",
    ].join("\n");

    expect(setEnvVar(original, KEY, "new")).toBe(`${original}${KEY}="new"\n`);
  });

  it("env file を指定しなければ .env を使う", () => {
    expect(parseArgs(["key.pem"])).toEqual({ privateKeyPath: "key.pem", envPath: ".env" });
  });

  it.each([
    { name: "秘密鍵の path より前", args: ["--env-file", ".env.local", "key.pem"] },
    { name: "秘密鍵の path より後", args: ["key.pem", "--env-file", ".env.local"] },
  ])("$name に置いた --env-file を読み取る", ({ args }) => {
    expect(parseArgs(args)).toEqual({ privateKeyPath: "key.pem", envPath: ".env.local" });
  });

  it("pnpm が先頭へ残す `--` を区切りとして取り除き、以降の option も読む", () => {
    expect(parseArgs(["--", "key.pem"])).toEqual({ privateKeyPath: "key.pem", envPath: ".env" });
    expect(parseArgs(["--", "--env-file", ".env.local", "key.pem"])).toEqual({
      privateKeyPath: "key.pem",
      envPath: ".env.local",
    });
    expect(parseArgs(["--env-file", ".env.local", "--", "key.pem"])).toEqual({
      privateKeyPath: "key.pem",
      envPath: ".env.local",
    });
  });

  it("一時 file を .env の ignore pattern 配下へ作る", () => {
    expect(createTemporaryEnvPath("/repo/.env", "test-id")).toBe("/repo/.env.test-id.tmp");
  });

  it("option の不足、未知の option、余分な path を拒否する", () => {
    expect(() => parseArgs(["--env-file"])).toThrow("--env-file requires a path");
    expect(() => parseArgs(["--unknown", "key.pem"])).toThrow("Unknown option");
    expect(() => parseArgs(["key.pem", "other.pem"])).toThrow("Unexpected argument");
  });

  it("ほかの値を保ったまま .env を mode 0600 で原子的に置換する", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    writeFileSync(keyPath, pkcs8Pem);
    writeFileSync(envPath, `GITHUB_APP_ID=123\n${KEY}=\nGITHUB_WEBHOOK_SECRET=keep\n`);
    chmodSync(envPath, 0o644);

    setGitHubPrivateKey(KEY, keyPath, envPath);

    expect(readFileSync(envPath, "utf8")).toBe(
      `GITHUB_APP_ID=123\n${KEY}="${escapeEnvValue(pkcs8Pem)}"\nGITHUB_WEBHOOK_SECRET=keep\n`
    );
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    { name: "空白付き", assignment: ` ${KEY} = old-value` },
    { name: "export", assignment: `export ${KEY}=old-value` },
    { name: "export と空白付き", assignment: ` export ${KEY} = old-value` },
  ])("Node が読む $name assignment を正規形一件へ原子的に置換する", ({ assignment }) => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-node-env-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    writeFileSync(keyPath, pkcs8Pem);
    writeFileSync(envPath, `${assignment}\nOTHER_VALUE=keep\n`);

    expect(readEnvFileWithNode(envPath, KEY)).toBe("old-value");

    setGitHubPrivateKey(KEY, keyPath, envPath);

    expect(readFileSync(envPath, "utf8")).toBe(`${KEY}="${escapeEnvValue(pkcs8Pem)}"\nOTHER_VALUE=keep\n`);
    expect(readEnvFileWithNode(envPath, KEY)).toBe(pkcs8Pem.trim());
  });

  it("Node が読む backtick multiline value 内の key 風文字列を assignment として扱わない", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-node-backtick-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    const original = [
      "OTHER_MULTILINE=`first line",
      `${KEY}=inside-backtick-value`,
      "last line`",
      "OTHER_VALUE=keep",
      "",
    ].join("\n");
    writeFileSync(keyPath, pkcs8Pem);
    writeFileSync(envPath, original);

    expect(readEnvFileWithNode(envPath, KEY)).toBe("");

    setGitHubPrivateKey(KEY, keyPath, envPath);

    expect(readFileSync(envPath, "utf8")).toBe(`${original}${KEY}="${escapeEnvValue(pkcs8Pem)}"\n`);
    expect(readEnvFileWithNode(envPath, KEY)).toBe(pkcs8Pem.trim());
    expect(readEnvFileWithNode(envPath, "OTHER_MULTILINE")).toBe(`first line\n${KEY}=inside-backtick-value\nlast line`);
  });

  it("Node と同様に backslash 直後の quote を終端とし次行の実 assignment を正規化する", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-node-backslash-quote-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    const otherAssignment = 'OTHER_VALUE="ends with backslash\\"\n';
    writeFileSync(keyPath, pkcs8Pem);
    writeFileSync(envPath, `${otherAssignment} ${KEY} = old-value\nOTHER_KEEP=keep\n`);

    expect(readEnvFileWithNode(envPath, "OTHER_VALUE")).toBe("ends with backslash\\");
    expect(readEnvFileWithNode(envPath, KEY)).toBe("old-value");

    setGitHubPrivateKey(KEY, keyPath, envPath);

    expect(readFileSync(envPath, "utf8")).toBe(
      `${otherAssignment}${KEY}="${escapeEnvValue(pkcs8Pem)}"\nOTHER_KEEP=keep\n`
    );
    expect(readEnvFileWithNode(envPath, "OTHER_VALUE")).toBe("ends with backslash\\");
    expect(readEnvFileWithNode(envPath, KEY)).toBe(pkcs8Pem.trim());
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("秘密鍵ファイルを読み込めないときは .env を変更しない", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-"));
    temporaryDirectories.push(directory);
    const envPath = join(directory, ".env");
    const original = `GITHUB_APP_ID=123\n${KEY}=unchanged\n`;
    writeFileSync(envPath, original);

    expect(() => {
      setGitHubPrivateKey(KEY, join(directory, "missing.pem"), envPath);
    }).toThrow();
    expect(readFileSync(envPath, "utf8")).toBe(original);
  });

  it.each([
    { name: "通常形式", original: `${KEY}="old"\nGITHUB_APP_ID=123\n${KEY}=older\n` },
    { name: "空白付き assignment と通常形式", original: `${KEY}=normal\n ${KEY} = spaced\nGITHUB_APP_ID=123\n` },
    { name: "export assignment と通常形式", original: `${KEY}=normal\n export ${KEY} = exported\nGITHUB_APP_ID=123\n` },
  ])("$name の重複 key があるときは write 前に失敗し .env を変更しない", ({ original }) => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    writeFileSync(keyPath, pkcs8Pem);
    writeFileSync(envPath, original);

    expect(() => {
      setGitHubPrivateKey(KEY, keyPath, envPath);
    }).toThrow(`Duplicate ${KEY} assignments`);
    expect(readFileSync(envPath, "utf8")).toBe(original);
  });

  it("PKCS#1 の秘密鍵を PKCS#8 へ正規化してから書き込む", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    writeFileSync(keyPath, pkcs1Pem);
    writeFileSync(envPath, `${KEY}=\n`);

    setGitHubPrivateKey(KEY, keyPath, envPath);

    const written = readFileSync(envPath, "utf8");
    expect(written).toContain("BEGIN PRIVATE KEY");
    expect(written).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("PKCS#8 の秘密鍵はそのまま PKCS#8 として書き込む", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    writeFileSync(keyPath, pkcs8Pem);
    writeFileSync(envPath, `${KEY}=\n`);

    setGitHubPrivateKey(KEY, keyPath, envPath);

    expect(readFileSync(envPath, "utf8")).toBe(`${KEY}="${escapeEnvValue(pkcs8Pem)}"\n`);
  });

  it("RSA 以外の秘密鍵は .env を変更せず error にする", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    const original = `GITHUB_APP_ID=123\n${KEY}=unchanged\n`;
    writeFileSync(envPath, original);

    expect(() => {
      setGitHubPrivateKey(KEY, keyPath, envPath);
    }).toThrow("is not an RSA private key");
    expect(readFileSync(envPath, "utf8")).toBe(original);
  });

  it("不正な秘密鍵は .env を変更せず error にする", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-key-env-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    writeFileSync(keyPath, "not a private key");
    const original = `GITHUB_APP_ID=123\n${KEY}=unchanged\n`;
    writeFileSync(envPath, original);

    expect(() => {
      setGitHubPrivateKey(KEY, keyPath, envPath);
    }).toThrow("is not a valid PEM private key");
    expect(readFileSync(envPath, "utf8")).toBe(original);
  });
});

describe("runSetGitHubPrivateKeyCli", () => {
  it("moduleUrl が実行中の module と一致しなければ何もしない", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // process.argv[1] は vitest の entry point であり、この架空の moduleUrl とは一致しない
    runSetGitHubPrivateKeyCli(KEY, "file:///not-the-entry-module.js");

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
