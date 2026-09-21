import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escapeEnvValue, setGitHubPrivateKey } from "@flightdeck/private-key-env";
import { afterEach, describe, expect, it } from "vitest";

import { PRIVATE_KEY_ENV_KEY } from "./set-github-private-key.js";

// 引数の parsing、quote/atomic 書き込みなどの分岐は @flightdeck/private-key-env 側で網羅的に検査済みのため、
// ここでは preflight が渡す key 名の配線が正しいことだけを確認する
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("set-github-private-key (preflight)", () => {
  it("preflight の .env は GITHUB_PRIVATE_KEY を使う", () => {
    expect(PRIVATE_KEY_ENV_KEY).toBe("GITHUB_PRIVATE_KEY");
  });

  it("共通実装を通じて .env の GITHUB_PRIVATE_KEY を mode 0600 で書き込む", () => {
    const directory = mkdtempSync(join(tmpdir(), "preflight-private-key-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "key.pem");
    const envPath = join(directory, ".env");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" });
    writeFileSync(keyPath, pkcs8Pem);
    writeFileSync(envPath, "GITHUB_APP_ID=123\n");

    setGitHubPrivateKey(PRIVATE_KEY_ENV_KEY, keyPath, envPath);

    expect(readFileSync(envPath, "utf8")).toBe(`GITHUB_APP_ID=123\nGITHUB_PRIVATE_KEY="${escapeEnvValue(pkcs8Pem)}"\n`);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });
});
