import { describe, expect, it, vi } from "vitest";

import { handleRepoAddAutocomplete } from "./installation-repo.js";
import { handleRepoAutocomplete } from "./repo.js";

import type { RepositoryIndex } from "../../../domain/repository.js";
import type { Env } from "../../../env.js";
import type { CachedInstallationRepositoryList } from "../../../repository/cache/interface.js";
import type { DiscordDependencies } from "../dependencies.js";
import type { APIApplicationCommandOptionChoice } from "discord-api-types/v10";
import type { Context } from "hono";

// GitHub は repository 名だけで 100 文字まで許すため、owner/name は Discord の 100 文字上限を超えうる
const LONG_NAME = "r".repeat(100);
const LONG_FULL_NAME = `org/${LONG_NAME}`;

const createContext = (org = "org"): Context<Env> =>
  ({
    env: { GITHUB_ORG: org },
    json: (value: unknown) => value as Response,
  }) as unknown as Context<Env>;

const choicesOf = (res: Response): APIApplicationCommandOptionChoice[] =>
  (res as unknown as { data: { choices: APIApplicationCommandOptionChoice[] } }).data.choices;

const index = (items: RepositoryIndex["items"]): RepositoryIndex => ({ items, updatedAt: "2026-08-12T00:00:00.000Z" });

describe("repository の autocomplete 候補", () => {
  it("登録済み repository の長い名前は name だけを 100 文字に切り詰め、value の repository ID は保つ", async () => {
    const deps = {
      repositoryAdminUsecase: {
        getCachedRepositoryIndex: vi
          .fn()
          .mockResolvedValue(
            index([
              { repoId: "1", owner: "org", name: LONG_NAME, fullName: LONG_FULL_NAME, htmlUrl: "https://example.com" },
            ])
          ),
      },
    } as unknown as DiscordDependencies;

    const choices = choicesOf(await handleRepoAutocomplete(createContext(), "", deps));

    expect(choices).toEqual([{ name: `${LONG_FULL_NAME.slice(0, 99)}…`, value: "1" }]);
  });

  it("/repo add の候補は name を 100 文字に切り詰め、value を repository 名にする", async () => {
    const installationRepositories: CachedInstallationRepositoryList = {
      items: [{ id: 1, owner: "org", name: LONG_NAME, fullName: LONG_FULL_NAME, htmlUrl: "https://example.com" }],
      fetchedAt: "2026-08-12T00:00:00.000Z",
    };
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockResolvedValue(installationRepositories),
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(index([])),
      },
    } as unknown as DiscordDependencies;

    const choices = choicesOf(await handleRepoAddAutocomplete(createContext(), "", deps));

    expect(choices).toEqual([{ name: `${LONG_FULL_NAME.slice(0, 99)}…`, value: LONG_NAME }]);
  });

  it("/repo add の候補から登録済みの repository を ID で除外する", async () => {
    const installationRepositories: CachedInstallationRepositoryList = {
      items: [
        { id: 1, owner: "org", name: "Renamed", fullName: "org/Renamed", htmlUrl: "https://example.com" },
        { id: 2, owner: "org", name: "other", fullName: "org/other", htmlUrl: "https://example.com" },
      ],
      fetchedAt: "2026-08-12T00:00:00.000Z",
    };
    // 登録済み index の表記は rename 前のまま残っている
    const registered = index([
      { repoId: "1", owner: "org", name: "renamed", fullName: "org/renamed", htmlUrl: "https://example.com" },
    ]);
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockResolvedValue(installationRepositories),
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(registered),
      },
    } as unknown as DiscordDependencies;

    const choices = choicesOf(await handleRepoAddAutocomplete(createContext(), "", deps));

    expect(choices).toEqual([{ name: "org/other", value: "other" }]);
  });

  it("/repo add の候補は GITHUB_ORG と owner の大文字小文字が違っても org 配下として出す", async () => {
    const installationRepositories: CachedInstallationRepositoryList = {
      items: [{ id: 1, owner: "org", name: "repo", fullName: "org/repo", htmlUrl: "https://example.com" }],
      fetchedAt: "2026-08-12T00:00:00.000Z",
    };
    const deps = {
      repositoryAdminUsecase: {
        getCachedInstallationRepositories: vi.fn().mockResolvedValue(installationRepositories),
        getCachedRepositoryIndex: vi.fn().mockResolvedValue(index([])),
      },
    } as unknown as DiscordDependencies;
    const choices = choicesOf(await handleRepoAddAutocomplete(createContext("Org"), "", deps));

    expect(choices).toEqual([{ name: "org/repo", value: "repo" }]);
  });
});
