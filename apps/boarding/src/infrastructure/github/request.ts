import * as v from "valibot";

import { BoardingError } from "../../errors.js";

const MAX_SUBREQUESTS = 35;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const API_ORIGIN = "https://api.github.com";

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export class GitHubHttpError extends BoardingError {
  constructor(readonly status: number) {
    super("API_ERROR", `GitHub returned ${String(status)}`);
  }
}

const valueAt = (data: unknown, path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (value, part) =>
      typeof value === "object" && value !== null ? (value as Record<string | number, unknown>)[part] : undefined,
    data
  );

export class GitHubRequest {
  private readonly budget: { requests: number };
  private readonly limit: number;

  constructor(
    private readonly fetcher: Fetcher,
    budget?: { requests: number },
    limit = MAX_SUBREQUESTS
  ) {
    this.budget = budget ?? { requests: 0 };
    this.limit = limit;
  }

  withLimit(limit: number): GitHubRequest {
    return new GitHubRequest(this.fetcher, this.budget, limit);
  }

  canSpend(count: number): boolean {
    return this.budget.requests + count <= this.limit;
  }

  async call(input: {
    method: "GET" | "POST" | "PATCH" | "PUT";
    path: string;
    token: string;
    body?: unknown;
    allowNotFound?: boolean | undefined;
    allowEmpty?: boolean | undefined;
  }): Promise<unknown> {
    if (this.budget.requests >= this.limit) {
      throw new BoardingError("SUBREQUEST_LIMIT", "GitHub request budget exceeded");
    }
    this.budget.requests += 1;

    const response = await this.fetcher(`${API_ORIGIN}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "flightdeck-boarding",
        "Content-Type": "application/json",
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: AbortSignal.timeout(15_000),
    }).catch((cause: unknown) => {
      throw new BoardingError("API_ERROR", "GitHub request failed", { cause });
    });

    if (response.status === 404 && input.allowNotFound) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubHttpError(response.status);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoardingError("INVALID_RESPONSE", "GitHub response is too large");
    }

    const stream = response.body as ReadableStream<Uint8Array> | null;
    const reader = stream?.getReader();
    if (!reader) {
      if (input.allowEmpty) return undefined;
      throw new BoardingError("INVALID_RESPONSE", "GitHub response body is missing");
    }

    const chunks: Uint8Array[] = [];
    let length = 0;

    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;

        length += chunk.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new BoardingError("INVALID_RESPONSE", "GitHub response is too large");
        }

        chunks.push(chunk.value);
      }
    } catch (cause) {
      if (cause instanceof BoardingError) throw cause;
      throw new BoardingError("API_ERROR", "GitHub response could not be read", { cause });
    }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    if (input.allowEmpty && bytes.length === 0) return undefined;

    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (cause) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub response is not JSON", { cause });
    }
  }

  async graphql(
    token: string,
    query: string,
    variables: Record<string, unknown>,
    userAliases: string[] = [],
    nullablePaths: (string | number)[][] = []
  ): Promise<unknown> {
    const response = await this.call({ method: "POST", path: "/graphql", token, body: { query, variables } });
    const result = v.safeParse(
      v.object({ data: v.optional(v.unknown()), errors: v.optional(v.array(v.unknown())) }),
      response
    );
    if (!result.success || result.output.data == null) {
      throw new BoardingError("API_ERROR", "GitHub GraphQL response is incomplete");
    }

    if ((result.output.errors?.length ?? 0) > 0) {
      const errors = v.safeParse(
        v.array(
          v.object({
            type: v.literal("NOT_FOUND"),
            path: v.pipe(v.array(v.union([v.string(), v.number()])), v.minLength(1)),
          })
        ),
        result.output.errors
      );

      const data = v.safeParse(v.record(v.string(), v.unknown()), result.output.data);
      if (!errors.success || !data.success) {
        throw new BoardingError("API_ERROR", "GitHub GraphQL response is incomplete");
      }

      const isAllowedError = (error: (typeof errors.output)[number]): boolean => {
        const path = error.path;
        const userAlias = path.length === 1 && typeof path[0] === "string" && userAliases.includes(path[0]);
        const nullablePath = nullablePaths.some(
          (allowed) => allowed.length === path.length && allowed.every((part, index) => part === path[index])
        );
        return (userAlias || nullablePath) && valueAt(data.output, path) === null;
      };

      if (errors.output.some((error) => !isAllowedError(error))) {
        throw new BoardingError("API_ERROR", "GitHub GraphQL response is incomplete");
      }
    }

    return result.output.data;
  }
}
