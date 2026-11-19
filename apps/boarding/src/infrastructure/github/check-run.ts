import * as v from "valibot";

import { authorizationCheckName } from "../../domain/merge.js";
import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { CheckOutput } from "../../message/check-run.js";
import type { EvaluationResult } from "../../usecase/evaluate/interface.js";

export class GitHubCheckRun {
  constructor(
    private readonly input: {
      request: GitHubRequest;
      getToken: () => Promise<string>;
      appId: number;
      verify: (number: number, baseSha: string, headSha: string) => Promise<void>;
    }
  ) {}

  async start(input: {
    number: number;
    baseSha: string;
    headSha: string;
    result: EvaluationResult;
    output: CheckOutput;
  }): Promise<number> {
    const token = await this.input.getToken();
    return this.write(token, input.headSha, input.result, input.output);
  }

  async finish(input: {
    number: number;
    baseSha: string;
    headSha: string;
    id: number;
    result: EvaluationResult;
    output: CheckOutput;
  }): Promise<void> {
    const token = await this.input.getToken();
    await this.input.verify(input.number, input.baseSha, input.headSha);
    await this.write(token, input.headSha, input.result, input.output, input.id);
  }

  private async write(
    token: string,
    headSha: string,
    result: EvaluationResult,
    output: CheckOutput,
    id?: number
  ): Promise<number> {
    const state =
      result.status === "waiting"
        ? { status: "in_progress" }
        : {
            status: "completed",
            conclusion: result.status === "allowed" || result.status === "not_applicable" ? "success" : "failure",
          };

    const endpoint =
      id !== undefined
        ? `/repos/densanken/blog-contents/check-runs/${String(id)}`
        : "/repos/densanken/blog-contents/check-runs";

    const updated = await this.input.request.call({
      method: id !== undefined ? "PATCH" : "POST",
      path: endpoint,
      token,
      body:
        id !== undefined
          ? { name: authorizationCheckName, ...state, output }
          : { name: authorizationCheckName, head_sha: headSha, ...state, output },
    });

    const checked = v.safeParse(
      v.object({
        id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        name: v.literal(authorizationCheckName),
        head_sha: v.string(),
        status: v.string(),
        conclusion: v.nullable(v.string()),
        app: v.object({ id: v.number() }),
      }),
      updated
    );
    if (
      !checked.success ||
      (id !== undefined && checked.output.id !== id) ||
      checked.output.head_sha !== headSha ||
      checked.output.app.id !== this.input.appId ||
      checked.output.status !== state.status ||
      (state.status === "completed" && checked.output.conclusion !== state.conclusion) ||
      (state.status === "in_progress" && checked.output.conclusion !== null)
    ) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub check run update was not confirmed");
    }

    return checked.output.id;
  }
}
