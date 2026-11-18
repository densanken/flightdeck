import * as v from "valibot";

import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { PullRequestData, RootFiles } from "../../usecase/evaluate/dependencies.js";

const person = v.object({ databaseId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), login: v.string() });
const actor = v.nullable(v.object({ user: v.nullable(person), email: v.optional(v.nullable(v.string())) }));
const pageInfo = v.object({ hasNextPage: v.boolean(), endCursor: v.nullable(v.string()) });
const query = `query Evaluation($number: Int!, $commits: String, $reviews: String, $includeTree: Boolean!) {
  repository(owner: "densanken", name: "blog-contents") {
    pullRequest(number: $number) {
      state baseRefName headRefOid changedFiles
      baseRef { target { oid ... on Commit {
        file(path: "authors") @include(if: $includeTree) { type object { __typename ... on Tree { entries { name type } } } }
      } } }
      author { __typename ... on User { databaseId login } ... on Bot { databaseId login } }
      commits(first: 100, after: $commits) { totalCount pageInfo { hasNextPage endCursor } nodes { commit {
        oid author { email user { databaseId login } } committer { user { databaseId login } }
        signature { isValid wasSignedByGitHub }
      } } }
      reviews(first: 100, after: $reviews) { pageInfo { hasNextPage endCursor } nodes {
        state submittedAt author { __typename ... on User { databaseId login } ... on Bot { databaseId login } } commit { oid }
      } }
    }
  }
}`;
const responseSchema = v.object({
  repository: v.object({
    pullRequest: v.object({
      state: v.string(),
      baseRefName: v.string(),
      baseRef: v.object({
        target: v.object({
          oid: v.string(),
          file: v.optional(
            v.nullable(
              v.object({
                type: v.literal("tree"),
                object: v.object({
                  __typename: v.literal("Tree"),
                  entries: v.array(v.object({ name: v.string(), type: v.string() })),
                }),
              })
            )
          ),
        }),
      }),
      headRefOid: v.string(),
      changedFiles: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      author: v.object({ ...person.entries, __typename: v.picklist(["User", "Bot"]) }),
      commits: v.object({
        totalCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        pageInfo,
        nodes: v.array(
          v.object({
            commit: v.object({
              oid: v.string(),
              author: actor,
              committer: actor,
              signature: v.nullable(v.object({ isValid: v.boolean(), wasSignedByGitHub: v.boolean() })),
            }),
          })
        ),
      }),
      reviews: v.object({
        pageInfo,
        nodes: v.array(
          v.object({
            state: v.picklist(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"]),
            submittedAt: v.nullable(v.string()),
            author: v.nullable(
              v.object({
                databaseId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
                login: v.string(),
                __typename: v.optional(v.string()),
              })
            ),
            commit: v.nullable(v.object({ oid: v.string() })),
          })
        ),
      }),
    }),
  }),
});

type ReviewNodes = v.InferOutput<typeof responseSchema>["repository"]["pullRequest"]["reviews"]["nodes"];

const mapReviews = (reviews: ReviewNodes): PullRequestData["reviews"] =>
  reviews.flatMap((review) => {
    if (review.author === null || review.state === "PENDING") return [];

    return [
      {
        reviewerId: review.author.databaseId,
        login: review.author.login,
        isBot: review.author.__typename === "Bot",
        state: review.state,
        submittedAt: review.submittedAt ?? "",
        commitSha: review.commit?.oid ?? null,
      },
    ];
  });

const compareSchema = v.object({
  permalink_url: v.string(),
  files: v.array(v.object({ filename: v.string(), status: v.string(), previous_filename: v.optional(v.string()) })),
});

const parseComparison = (response: unknown, baseSha: string, headSha: string, changedFiles: number) => {
  const result = v.safeParse(compareSchema, response);
  if (!result.success) throw new BoardingError("INVALID_RESPONSE", "GitHub comparison is invalid");

  const refs = result.output.permalink_url.split("/compare/")[1]?.split("...");
  const base = refs?.[0]?.split(":").at(-1);
  const head = refs?.[1]?.split(":").at(-1);
  if (refs?.length !== 2 || base !== baseSha || head !== headSha) {
    throw new BoardingError("INVALID_RESPONSE", "GitHub comparison references do not match");
  }

  const changed = result.output.files;
  if (changed.length >= 300 || changed.length !== changedFiles) {
    throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub changed files are incomplete");
  }

  if (changed.some((file) => file.status === "renamed" && !file.previous_filename)) {
    throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub rename source is missing");
  }

  const files = changed.map((file) => ({ path: file.filename, previousPath: file.previous_filename }));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub changed files contain duplicates");
  }

  return files;
};

const fileExpressions = (
  baseSha: string,
  headSha: string,
  roots: string[],
  profileRoots: string[],
  metaRoots: string[]
): string[] => {
  return roots.flatMap((root) => [
    ...["meta.yaml", "meta.yml"].map((name) => `${baseSha}:authors/${root}/${name}`),
    ...(metaRoots.includes(root) ? ["meta.yaml", "meta.yml"].map((name) => `${headSha}:authors/${root}/${name}`) : []),
    ...(profileRoots.includes(root)
      ? [baseSha, headSha].flatMap((sha) =>
          ["profile.yaml", "profile.yml"].map((name) => `${sha}:authors/${root}/${name}`)
        )
      : []),
  ]);
};

const parseFileContents = (response: unknown, expressions: string[]): (string | null)[] => {
  const blob = v.nullable(
    v.object({
      __typename: v.literal("Blob"),
      text: v.nullable(v.string()),
      isBinary: v.literal(false),
      isTruncated: v.literal(false),
    })
  );
  const schema = v.object({ repository: v.record(v.string(), blob) });
  const parsed = v.safeParse(schema, response);
  if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "GitHub file response is invalid");

  return expressions.map((_, index) => {
    const value = parsed.output.repository[`f${String(index)}`];
    if (value === undefined || (value !== null && value.text === null)) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub file content is unavailable");
    }

    return value?.text ?? null;
  });
};

const fileQuery = (expressions: string[]): string => {
  const selections = expressions
    .map(
      (expression, index) =>
        `f${String(index)}: object(expression: ${JSON.stringify(expression)}) { __typename ... on Blob { text isBinary isTruncated } }`
    )
    .join("\n");

  return `query { repository(owner: "densanken", name: "blog-contents") { ${selections} } }`;
};

export class GitHubGatewayImpl {
  constructor(private readonly input: { request: GitHubRequest; getToken: () => Promise<string> }) {}

  async pullRequest(number: number): Promise<PullRequestData> {
    const token = await this.input.getToken();
    const data = await this.input.request.graphql(token, query, {
      number,
      commits: null,
      reviews: null,
      includeTree: true,
    });

    const parsed = v.safeParse(responseSchema, data);
    if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "GitHub pull request response is invalid");

    const { pullRequest: pr } = parsed.output.repository;
    if (pr.baseRef.target.file === undefined)
      throw new BoardingError("INVALID_RESPONSE", "GitHub authors tree is unavailable");

    const baseRoots = (pr.baseRef.target.file?.object.entries ?? [])
      .filter((entry) => entry.type === "tree")
      .map((entry) => entry.name);
    const { commits, reviews } = await this.loadPages(number, token, pr);

    const response = await this.input.request.call({
      method: "GET",
      path: `/repos/densanken/blog-contents/compare/${encodeURIComponent(pr.baseRef.target.oid)}...${encodeURIComponent(pr.headRefOid)}?per_page=1&page=1`,
      token,
    });

    const files = parseComparison(response, pr.baseRef.target.oid, pr.headRefOid, pr.changedFiles);

    return {
      state: pr.state,
      baseBranch: pr.baseRefName,
      baseSha: pr.baseRef.target.oid,
      headSha: pr.headRefOid,
      author: { id: pr.author.databaseId, login: pr.author.login, isBot: pr.author.__typename === "Bot" },
      files,
      commits: commits.map(({ commit }) => ({
        sha: commit.oid,
        authorId: commit.author?.user?.databaseId ?? null,
        authorEmail: commit.author?.email ?? null,
        committerId: commit.committer?.user?.databaseId ?? null,
        committerLogin: commit.committer?.user?.login ?? null,
        signature: commit.signature,
      })),
      reviews: mapReviews(reviews),
      baseRoots,
    };
  }

  private async loadPages(
    number: number,
    token: string,
    pr: v.InferOutput<typeof responseSchema>["repository"]["pullRequest"]
  ) {
    const commits = [...pr.commits.nodes];
    const reviews = [...pr.reviews.nodes];
    let commitPage = pr.commits.pageInfo;
    let reviewPage = pr.reviews.pageInfo;
    const commitCursors = new Set<string>();
    const reviewCursors = new Set<string>();

    while (commitPage.hasNextPage || reviewPage.hasNextPage) {
      const commitCursor = commitPage.hasNextPage ? commitPage.endCursor : null;
      const reviewCursor = reviewPage.hasNextPage ? reviewPage.endCursor : null;

      if (
        (commitPage.hasNextPage && (!commitCursor || commitCursors.has(commitCursor))) ||
        (reviewPage.hasNextPage && (!reviewCursor || reviewCursors.has(reviewCursor)))
      ) {
        throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub pagination did not advance");
      }

      if (commitCursor) commitCursors.add(commitCursor);
      if (reviewCursor) reviewCursors.add(reviewCursor);

      const nextData = await this.input.request.graphql(token, query, {
        number,
        commits: commitCursor,
        reviews: reviewCursor,
        includeTree: false,
      });

      const next = v.safeParse(responseSchema, nextData);
      if (!next.success) throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub commits or reviews are incomplete");

      const current = next.output.repository.pullRequest;
      if (
        current.baseRef.target.oid !== pr.baseRef.target.oid ||
        current.headRefOid !== pr.headRefOid ||
        current.changedFiles !== pr.changedFiles ||
        current.commits.totalCount !== pr.commits.totalCount
      ) {
        throw new BoardingError("API_ERROR", "Pull request changed during pagination");
      }

      if (commitPage.hasNextPage) {
        commits.push(...current.commits.nodes);
        commitPage = current.commits.pageInfo;
      }

      if (reviewPage.hasNextPage) {
        reviews.push(...current.reviews.nodes);
        reviewPage = current.reviews.pageInfo;
      }
    }

    if (commits.length !== pr.commits.totalCount) {
      throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub commits are incomplete");
    }

    return { commits, reviews };
  }

  async current(number: number): Promise<{ state: string; baseBranch: string; baseSha: string; headSha: string }> {
    const query = `query Verify($number: Int!) { repository(owner: "densanken", name: "blog-contents") { pullRequest(number: $number) { state baseRefName baseRef { target { oid } } headRefOid } } }`;
    const response = await this.input.request.graphql(await this.input.getToken(), query, { number });
    const parsed = v.safeParse(
      v.object({
        repository: v.object({
          pullRequest: v.object({
            state: v.string(),
            baseRefName: v.string(),
            baseRef: v.object({ target: v.object({ oid: v.string() }) }),
            headRefOid: v.string(),
          }),
        }),
      }),
      response
    );
    if (!parsed.success) throw new BoardingError("INVALID_RESPONSE", "Pull request reference is invalid");

    const pr = parsed.output.repository.pullRequest;
    return { state: pr.state, baseBranch: pr.baseRefName, baseSha: pr.baseRef.target.oid, headSha: pr.headRefOid };
  }

  async verify(number: number, baseSha: string, headSha: string): Promise<void> {
    const pr = await this.current(number);
    if (pr.state !== "OPEN" || pr.baseBranch !== "main" || pr.baseSha !== baseSha || pr.headSha !== headSha) {
      throw new BoardingError("API_ERROR", "Pull request changed during evaluation");
    }
  }

  async files(
    baseSha: string,
    headSha: string,
    roots: string[],
    profileRoots: string[],
    metaRoots: string[]
  ): Promise<{ root: string; before: RootFiles; after: RootFiles }[]> {
    const expressions = fileExpressions(baseSha, headSha, roots, profileRoots, metaRoots);
    if (expressions.length === 0) return [];

    const query = fileQuery(expressions);
    const response = await this.input.request.graphql(await this.input.getToken(), query, {});
    const values = parseFileContents(response, expressions);
    const encoder = new TextEncoder();
    const sizes = values
      .filter((value): value is string => value !== null)
      .map((value) => encoder.encode(value).byteLength);

    if (sizes.some((size) => size > 16 * 1024) || sizes.reduce((sum, size) => sum + size, 0) > 64 * 1024) {
      throw new BoardingError("YAML_SIZE_LIMIT", "YAML size limit exceeded");
    }

    const content = new Map(expressions.map((expression, index) => [expression, values[index] ?? null]));
    const toFiles = (sha: string, root: string): RootFiles => ({
      metaYaml: content.get(`${sha}:authors/${root}/meta.yaml`) ?? null,
      metaYml: content.get(`${sha}:authors/${root}/meta.yml`) ?? null,
      profileYaml: content.get(`${sha}:authors/${root}/profile.yaml`) ?? null,
      profileYml: content.get(`${sha}:authors/${root}/profile.yml`) ?? null,
    });

    return roots.map((root) => ({ root, before: toFiles(baseSha, root), after: toFiles(headSha, root) }));
  }
}
