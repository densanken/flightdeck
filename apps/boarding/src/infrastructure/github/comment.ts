import * as v from "valibot";

import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";

const marker = "<!-- boarding:authorization -->";
const commentsSchema = v.array(
  v.object({
    id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    body: v.string(),
    user: v.nullable(v.object({ id: v.number() })),
  })
);

export class GitHubComment {
  constructor(
    private readonly input: {
      request: GitHubRequest;
      getToken: () => Promise<string>;
      botUserId: number;
      verify: (number: number, baseSha: string, headSha: string) => Promise<void>;
    }
  ) {}

  async write(input: { number: number; baseSha: string; headSha: string; body: string }): Promise<void> {
    const token = await this.input.getToken();
    const id = await this.findManaged(token, input.number);
    const path =
      id === undefined
        ? `/repos/densanken/blog-contents/issues/${String(input.number)}/comments`
        : `/repos/densanken/blog-contents/issues/comments/${String(id)}`;
    await this.input.verify(input.number, input.baseSha, input.headSha);

    await this.send(token, { method: id === undefined ? "POST" : "PATCH", path, id, body: input.body });
  }

  // 閉じた PR が対象のため、Open の確認はしない。管理コメントがなければ作らない
  async updateExisting(input: { number: number; body: string }): Promise<void> {
    const token = await this.input.getToken();
    const id = await this.findManaged(token, input.number);
    if (id === undefined) return;

    await this.send(token, {
      method: "PATCH",
      path: `/repos/densanken/blog-contents/issues/comments/${String(id)}`,
      id,
      body: input.body,
    });
  }

  private async findManaged(token: string, number: number): Promise<number | undefined> {
    const found: number[] = [];

    for (let page = 1; ; page += 1) {
      const data = await this.input.request.call({
        method: "GET",
        path: `/repos/densanken/blog-contents/issues/${String(number)}/comments?per_page=100&page=${String(page)}`,
        token,
      });

      const parsed = v.safeParse(commentsSchema, data);
      if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "GitHub comments are invalid");

      found.push(
        ...parsed.output
          .filter((comment) => comment.user?.id === this.input.botUserId && comment.body.startsWith(marker))
          .map((comment) => comment.id)
      );

      if (found.length > 0 || parsed.output.length < 100) break;
      if (page >= 2) throw new BoardingError("SUBREQUEST_LIMIT", "GitHub pagination budget exceeded");
    }

    if (found.length > 1) throw new BoardingError("INVALID_RESPONSE", "Multiple managed comments exist");

    return found[0];
  }

  private async send(
    token: string,
    input: { method: "POST" | "PATCH"; path: string; id: number | undefined; body: string }
  ): Promise<void> {
    const updated = await this.input.request.call({
      method: input.method,
      path: input.path,
      token,
      body: { body: input.body },
    });

    const checked = v.safeParse(
      v.object({
        id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        body: v.string(),
        user: v.object({ id: v.number() }),
      }),
      updated
    );
    if (
      !checked.success ||
      (input.id !== undefined && checked.output.id !== input.id) ||
      checked.output.body !== input.body ||
      checked.output.user.id !== this.input.botUserId
    ) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub comment update was not confirmed");
    }
  }
}
