import * as v from "valibot";

import { authorizationCheckName } from "../../domain/merge.js";
import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { EvaluationResult } from "../../usecase/evaluate/interface.js";

const responseSchema = v.object({
  total_count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  check_runs: v.array(
    v.object({
      id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
      name: v.string(),
      head_sha: v.string(),
      app: v.nullable(v.object({ id: v.number() })),
    })
  ),
});

export class GitHubCheckRun {
  constructor(
    private readonly input: {
      request: GitHubRequest;
      getToken: () => Promise<string>;
      appId: number;
      verify: (number: number, baseSha: string, headSha: string) => Promise<void>;
    }
  ) {}

  async start(input: { number: number; baseSha: string; headSha: string }): Promise<number> {
    const token = await this.input.getToken();
    const id = await this.find(token, input.headSha);

    return this.write(token, input.headSha, { status: "waiting", reason: "EVALUATING" }, id);
  }

  async finish(input: {
    number: number;
    baseSha: string;
    headSha: string;
    id: number;
    result: EvaluationResult;
  }): Promise<void> {
    const token = await this.input.getToken();
    await this.input.verify(input.number, input.baseSha, input.headSha);
    await this.write(token, input.headSha, input.result, input.id);
  }

  private async find(token: string, headSha: string): Promise<number | undefined> {
    const runs: v.InferOutput<typeof responseSchema>["check_runs"] = [];

    for (let page = 1; ; page += 1) {
      const path = `/repos/densanken/blog-contents/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(authorizationCheckName)}&filter=all&app_id=${String(this.input.appId)}&per_page=100&page=${String(page)}`;
      const parsed = v.safeParse(responseSchema, await this.input.request.call({ method: "GET", path, token }));
      if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "GitHub check runs are invalid");
      if (parsed.output.total_count > 200) throw new BoardingError("SUBREQUEST_LIMIT", "Too many check runs");

      runs.push(...parsed.output.check_runs);
      if (runs.length === parsed.output.total_count) break;
      if (parsed.output.check_runs.length === 0 || runs.length > parsed.output.total_count) {
        throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub check runs are incomplete");
      }
    }

    return runs
      .filter(
        (run) => run.name === authorizationCheckName && run.head_sha === headSha && run.app?.id === this.input.appId
      )
      .sort((a, b) => b.id - a.id)[0]?.id;
  }

  private async write(
    token: string,
    headSha: string,
    result: EvaluationResult,
    id: number | undefined
  ): Promise<number> {
    const output = { title: "認可結果", summary: result.reason };
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
