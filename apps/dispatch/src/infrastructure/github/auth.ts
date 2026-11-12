import { createGitHubAppJwt } from "@flightdeck/github-app-jwt";
import { splitRepository } from "@flightdeck/rules";
import { z } from "zod";

import { callGitHub, parseResponse } from "./request.js";
import { DispatchError } from "../../errors.js";

import type { Fetcher } from "./request.js";

const installationSchema = z.object({ id: z.number() });
const accessTokenSchema = z.object({ token: z.string() });

// key ごとに make の結果（Promise）を保持し、同じ key では再実行しない
const cachedPromise = <K, V>(cache: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> => {
  const existing = cache.get(key);
  if (existing) return existing;

  const created = make();
  cache.set(key, created);

  return created;
};

// repository の owner（user か Organization）ごとの Installation token を返す
// App は owner ごとに 1 つの Installation を持つ
// event の repository の owner は、Webhook が署名つきで運ぶ Installation の ID から始める（lookup 不要）
// 1 つの Queue message の処理中だけ使うので、JWT（10 分）と token（1 時間）の期限切れは考慮しない
export class GitHubInstallationTokenProvider {
  private readonly installationIds = new Map<string, Promise<number>>();
  private readonly installationTokens = new Map<number, Promise<string>>();
  private jwt: Promise<string> | undefined;

  constructor(
    private readonly input: {
      fetcher: Fetcher;
      appId: string;
      privateKeyPem: string;
      installation: { owner: string; id: number };
    }
  ) {
    this.installationIds.set(input.installation.owner.toLowerCase(), Promise.resolve(input.installation.id));
  }

  async getToken(repository: string): Promise<string> {
    const owner = splitRepository(repository).owner.toLowerCase();
    const id = await cachedPromise(this.installationIds, owner, () => this.lookup(repository));

    return cachedPromise(this.installationTokens, id, () => this.issue(id));
  }

  private signJwt(): Promise<string> {
    this.jwt ??= createGitHubAppJwt({ appId: this.input.appId, privateKeyPem: this.input.privateKeyPem }).catch(() => {
      throw new DispatchError("permission", "GitHub App JWT could not be generated");
    });

    return this.jwt;
  }

  // owner ごとに最初に見た repository で探す（1 つの owner の Installation は 1 つ）
  private async lookup(repository: string): Promise<number> {
    const installation = await callGitHub(this.input.fetcher, await this.signJwt(), {
      method: "GET",
      path: `/repos/${repository}/installation`,
      optional: true,
    });
    if (installation === undefined) throw new DispatchError("permission", `GitHub App is not installed: ${repository}`);

    return parseResponse(installationSchema, installation, "installation").id;
  }

  private async issue(installationId: number): Promise<string> {
    const accessToken = await callGitHub(this.input.fetcher, await this.signJwt(), {
      method: "POST",
      path: `/app/installations/${String(installationId)}/access_tokens`,
    });

    return parseResponse(accessTokenSchema, accessToken, "access token").token;
  }
}
