import { createGitHubAppJwt } from "@flightdeck/github-app-jwt";
import * as v from "valibot";

import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";

export class GitHubInstallationTokenProvider {
  private token: Promise<string> | undefined;
  private jwt: Promise<string> | undefined;

  constructor(
    private readonly input: {
      request: GitHubRequest;
      appId: string;
      privateKeyPem: string;
      installationId: number;
    }
  ) {}

  getToken(): Promise<string> {
    this.token ??= this.issue();

    return this.token;
  }

  private signJwt(): Promise<string> {
    this.jwt ??= createGitHubAppJwt({ appId: this.input.appId, privateKeyPem: this.input.privateKeyPem }).catch(
      (cause: unknown) => {
        throw new BoardingError("API_ERROR", "GitHub App authentication failed", { cause });
      }
    );

    return this.jwt;
  }

  async verifyInstallation(): Promise<void> {
    const data = await this.input.request.call({
      method: "GET",
      path: "/repos/densanken/blog-contents/installation",
      token: await this.signJwt(),
    });

    const parsed = v.safeParse(
      v.object({ id: v.number(), account: v.object({ login: v.string(), type: v.literal("Organization") }) }),
      data
    );
    if (
      !parsed.success ||
      parsed.output.id !== this.input.installationId ||
      parsed.output.account.login.toLowerCase() !== "densanken"
    ) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub installation does not match the target repository");
    }
  }

  private async issue(): Promise<string> {
    const response = await this.input.request.call({
      method: "POST",
      path: `/app/installations/${String(this.input.installationId)}/access_tokens`,
      token: await this.signJwt(),
    });

    const parsed = v.safeParse(
      v.object({
        token: v.pipe(v.string(), v.minLength(1)),
        permissions: v.object({ members: v.picklist(["read", "write"]) }),
      }),
      response
    );
    if (!parsed.success) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub installation token or Members permission is missing");
    }

    return parsed.output.token;
  }
}
