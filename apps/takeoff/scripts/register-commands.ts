import { pathToFileURL } from "node:url";

import { z } from "zod";

import { commands } from "../src/handler/discord/commands.js";

const registrationResponseSchema = z.array(z.unknown());

export interface RegisterCommandsEnvironment {
  DISCORD_APPLICATION_ID?: string;
  DISCORD_BOT_TOKEN?: string;
  ALLOWED_GUILD_IDS?: string;
  WORKERS_CI?: string;
  WORKERS_CI_BRANCH?: string;
}

class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export const registerCommands = async (
  environment: RegisterCommandsEnvironment,
  fetcher: typeof fetch = fetch
): Promise<number> => {
  const applicationId = environment.DISCORD_APPLICATION_ID;
  const botToken = environment.DISCORD_BOT_TOKEN;
  const allowedGuildIds = (environment.ALLOWED_GUILD_IDS ?? "")
    .split(",")
    .map((guildId) => guildId.trim())
    .filter(Boolean);
  if (!applicationId || !botToken) {
    throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must be set");
  }
  if (allowedGuildIds.length === 0) {
    throw new Error("ALLOWED_GUILD_IDS must contain at least one guild ID");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bot ${botToken}`,
  };
  const globalResponse = await fetcher(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
    method: "PUT",
    headers,
    body: "[]",
  });
  await parseRegistrationResponse(globalResponse, "clear global commands");

  let registeredCount = 0;
  for (const guildId of allowedGuildIds) {
    const response = await fetcher(
      `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(commands),
      }
    );
    registeredCount += await parseRegistrationResponse(response, `register commands for guild ${guildId}`);
  }

  return registeredCount;
};

const parseRegistrationResponse = async (response: Response, operation: string): Promise<number> => {
  if (!response.ok) {
    throw new DiscordHttpError(response.status, `Failed to ${operation}: HTTP ${String(response.status)}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`Discord returned invalid JSON while attempting to ${operation}`);
  }

  const parsed = registrationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Discord returned an invalid response while attempting to ${operation}`);
  }
  return parsed.data.length;
};

// 終了コードを返す
// Workers Builds では build command から実行する
// main 以外の branch の build で本番 guild の command を上書きしないよう登録を skip し、
// main branch の build では Discord の rate limit（429）で deploy 全体を失敗させないよう成功扱いにする
export const main = async (
  environment: RegisterCommandsEnvironment,
  fetcher: typeof fetch = fetch
): Promise<number> => {
  const isWorkersBuild = environment.WORKERS_CI === "1";
  if (isWorkersBuild && environment.WORKERS_CI_BRANCH !== "main") {
    console.log(`Skipping command registration on branch "${environment.WORKERS_CI_BRANCH ?? "(unknown)"}".`);
    return 0;
  }

  try {
    const count = await registerCommands(environment, fetcher);
    console.log(`Registered ${String(count)} commands successfully.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to register commands";
    if (isWorkersBuild && error instanceof DiscordHttpError && error.status === 429) {
      // 429 の前に完了した PUT は反映済みのため、登録が中途半端な可能性がある
      console.warn(`${message}. Command registration may be incomplete; re-run register-commands manually.`);
      return 0;
    }
    console.error(message);
    return 1;
  }
};

const mainModuleUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === mainModuleUrl) {
  process.exitCode = await main(process.env);
}
