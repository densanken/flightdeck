import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, registerCommands } from "./register-commands.js";

const temporaryDirectories: string[] = [];
const takeoffDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("registerCommands", () => {
  it("Discord API へ command を bulk overwrite する", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{}, {}, {}, {}, {}, {}]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const count = await registerCommands(
      {
        DISCORD_APPLICATION_ID: "application-id",
        DISCORD_BOT_TOKEN: "bot-token",
        ALLOWED_GUILD_IDS: "guild-id",
      },
      fetcher
    );

    expect(count).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.at(0)?.[0]).toBe("https://discord.com/api/v10/applications/application-id/commands");
    expect(fetcher.mock.calls.at(0)?.[1]?.method).toBe("PUT");
    expect(fetcher.mock.calls.at(0)?.[1]?.body).toBe("[]");
    expect(new Headers(fetcher.mock.calls.at(0)?.[1]?.headers).get("Authorization")).toBe("Bot bot-token");
    expect(fetcher.mock.calls.at(1)?.[0]).toBe(
      "https://discord.com/api/v10/applications/application-id/guilds/guild-id/commands"
    );
  });

  it("Discord API の失敗時に token を含まない error を返す", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 500 }));

    await expect(
      registerCommands(
        {
          DISCORD_APPLICATION_ID: "application-id",
          DISCORD_BOT_TOKEN: "secret-bot-token",
          ALLOWED_GUILD_IDS: "guild-id",
        },
        fetcher
      )
    ).rejects.not.toThrow("secret-bot-token");
  });

  it("許可 guild が未設定なら Discord API を呼ばない", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      registerCommands(
        {
          DISCORD_APPLICATION_ID: "application-id",
          DISCORD_BOT_TOKEN: "bot-token",
        },
        fetcher
      )
    ).rejects.toThrow("ALLOWED_GUILD_IDS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("package command は任意の .env を読み込み、shell environment を優先する", () => {
    const packageJson = readFileSync(join(takeoffDirectory, "package.json"), "utf8");
    expect(packageJson).toContain(
      '"register-commands": "node --env-file-if-exists=.env --import tsx scripts/register-commands.ts"'
    );

    const directory = mkdtempSync(join(tmpdir(), "takeoff-register-commands-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, ".env"),
      "DISCORD_APPLICATION_ID=file-application-id\nDISCORD_BOT_TOKEN=file-token\nALLOWED_GUILD_IDS=file-guild-id\n"
    );
    const result = spawnSync(
      process.execPath,
      [
        "--env-file-if-exists=.env",
        "--eval",
        "console.log(JSON.stringify([process.env.DISCORD_APPLICATION_ID, process.env.DISCORD_BOT_TOKEN, process.env.ALLOWED_GUILD_IDS]))",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: process.env.PATH, DISCORD_BOT_TOKEN: "shell-token" },
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('["file-application-id","shell-token","file-guild-id"]');
  });

  it(".env がない場合も shell environment を読み、失敗時に token を出力しない", () => {
    const directory = mkdtempSync(join(tmpdir(), "takeoff-register-commands-no-env-"));
    temporaryDirectories.push(directory);
    const registerCommandsScript = fileURLToPath(new URL("./register-commands.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [`--env-file-if-exists=${join(directory, ".env")}`, "--import", "tsx", registerCommandsScript],
      {
        cwd: takeoffDirectory,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          DISCORD_BOT_TOKEN: "subprocess-secret-token",
          ALLOWED_GUILD_IDS: "guild-id",
        },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DISCORD_APPLICATION_ID");
    expect(result.stderr).not.toContain("subprocess-secret-token");
  });
});

describe("main", () => {
  const environment = {
    DISCORD_APPLICATION_ID: "application-id",
    DISCORD_BOT_TOKEN: "bot-token",
    ALLOWED_GUILD_IDS: "guild-id",
  };

  it("main branch の Workers Builds では guild への登録の 429 を警告して成功扱いにする", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // この test では console.warn の出力を意図的に抑止する
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }));

    expect(await main({ ...environment, WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }, fetcher)).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("may be incomplete"));
  });

  it("Workers Builds 以外では 429 を失敗にする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 429 }));

    expect(await main(environment, fetcher)).toBe(1);
  });

  it.each(["feature", undefined])(
    "branch が %s の Workers Builds では Discord API を呼ばずに成功扱いにする",
    async (branch) => {
      vi.spyOn(console, "log").mockImplementation(() => {
        // この test では console.log の出力を意図的に抑止する
      });
      const fetcher = vi.fn<typeof fetch>();

      expect(await main({ ...environment, WORKERS_CI: "1", WORKERS_CI_BRANCH: branch }, fetcher)).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it("main branch の Workers Builds でも 429 以外は失敗にする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      // この test では console.error の出力を意図的に抑止する
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 500 }));

    expect(await main({ ...environment, WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }, fetcher)).toBe(1);
  });
});
