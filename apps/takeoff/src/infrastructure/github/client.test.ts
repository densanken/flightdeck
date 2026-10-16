import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubClientImpl, GitHubError, createGitHubResponseError } from "./client.js";
import { logger } from "../../util/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

const jsonResponse = (value: unknown, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
};

// ---------------------------------------------------------------------------
// createGitHubResponseError
// ---------------------------------------------------------------------------

describe("createGitHubResponseError - rate limit 検出", () => {
  it("status 429 で github_rate_limited エラーを返す", async () => {
    const response = new Response("Too Many Requests", { status: 429 });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error).toBeInstanceOf(GitHubError);
    expect(error.type).toBe("github_rate_limited");
    expect(error.statusCode).toBe(503);
  });

  it("x-ratelimit-remaining: 0 ヘッダで github_rate_limited エラーを返す", async () => {
    const response = new Response("OK", {
      status: 200,
      headers: { "x-ratelimit-remaining": "0" },
    });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error.type).toBe("github_rate_limited");
    expect(error.statusCode).toBe(503);
  });

  it("retry-after ヘッダで github_rate_limited エラーを返す", async () => {
    const response = new Response("OK", {
      status: 200,
      headers: { "retry-after": "60" },
    });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error.type).toBe("github_rate_limited");
    expect(error.statusCode).toBe(503);
  });

  it("body に 'rate limit' を含む場合 github_rate_limited エラーを返す", async () => {
    const response = new Response("API rate limit exceeded", { status: 403 });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error.type).toBe("github_rate_limited");
    expect(error.statusCode).toBe(503);
  });
});

describe("createGitHubResponseError - 404", () => {
  it("404 で notFoundType に応じたエラーを返す (pr_not_found → statusCode 404)", async () => {
    const response = new Response("Not Found", { status: 404 });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error.type).toBe("pr_not_found");
    expect(error.statusCode).toBe(404);
  });

  it("404 で notFoundType が repo_not_found の場合も statusCode 404 を返す", async () => {
    const response = new Response("Not Found", { status: 404 });

    const error = await createGitHubResponseError(response, "test context", "repo_not_found");

    expect(error.type).toBe("repo_not_found");
    expect(error.statusCode).toBe(404);
  });
});

describe("createGitHubResponseError - 認証・認可エラー", () => {
  it("401 で github_app_permission_missing エラーを返す", async () => {
    const response = new Response("Unauthorized", { status: 401 });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error.type).toBe("github_app_permission_missing");
    expect(error.statusCode).toBe(503);
  });

  it("403 で github_app_permission_missing エラーを返す", async () => {
    const response = new Response("Forbidden", { status: 403 });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error.type).toBe("github_app_permission_missing");
    expect(error.statusCode).toBe(503);
  });

  it("失敗した response の status と GitHub の message、必要な権限を記録する", async () => {
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    const response = jsonResponse(
      { message: "Resource not accessible by integration", documentation_url: "https://docs.github.com/rest" },
      403,
      { "X-GitHub-Request-Id": "request-id", "X-Accepted-GitHub-Permissions": "contents=write" }
    );

    await createGitHubResponseError(response, "mergePullRequest org/repo#1", "pr_not_found");

    expect(logSpy).toHaveBeenCalledWith("warn", {
      event: "github_api_failed",
      context: "mergePullRequest org/repo#1",
      githubStatus: 403,
      githubRequestId: "request-id",
      acceptedPermissions: "contents=write",
      githubMessage: "Resource not accessible by integration",
    });
  });

  it("Rules API を private repository で使えない 403 は権限不足に誤分類しない", async () => {
    const response = jsonResponse(
      { message: "Upgrade to GitHub Pro or make this repository public to enable this feature." },
      403
    );

    const error = await createGitHubResponseError(
      response,
      "getRequiredStatusChecksForBranch org/repo@main page=1",
      "repo_not_found"
    );

    expect(error).toMatchObject({ type: "github_rules_api_unavailable", statusCode: 409 });
  });
});

describe("createGitHubResponseError - その他のステータス", () => {
  it("その他のステータスで unexpected_github_error エラーを返す", async () => {
    const response = new Response("Internal Server Error", { status: 500 });

    const error = await createGitHubResponseError(response, "test context", "pr_not_found");

    expect(error.type).toBe("unexpected_github_error");
    expect(error.statusCode).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GitHubClientImpl
// ---------------------------------------------------------------------------

const mockRepo = {
  id: 1,
  name: "repo",
  full_name: "org/repo",
  html_url: "https://github.com/org/repo",
  owner: { login: "org" },
};

const mockPullRequest = {
  number: 1,
  title: "feat: test",
  html_url: "https://github.com/org/repo/pull/1",
  state: "open",
  draft: false,
  mergeable: true,
  merge_commit_sha: "test-merge-sha",
  head: { sha: "abc", ref: "feature", label: "org:feature", repo: { id: 101 } },
  base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
  user: { login: "user" },
  updated_at: "2024-01-01T00:00:00Z",
};

const mockPullRequestSummary = {
  number: 1,
  title: "feat: test",
  html_url: "https://github.com/org/repo/pull/1",
  state: "open",
  draft: false,
  head: { sha: "abc", ref: "feature", label: "org:feature", repo: { id: 101 } },
  base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
  user: { login: "user" },
  updated_at: "2024-01-01T00:00:00Z",
};

describe("GitHubClientImpl - getRepository", () => {
  it("正常なレスポンスを parse して返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse(mockRepo));

    const result = await client.getRepository("token", "org", "repo");

    expect(result.id).toBe(1);
    expect(result.full_name).toBe("org/repo");
  });

  it("404 で repo_not_found エラーを投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    await expect(client.getRepository("token", "org", "repo")).rejects.toMatchObject({
      type: "repo_not_found",
      statusCode: 404,
    });
  });

  it("owner/repo に URL 特殊文字を含む場合、fetch へ渡す URL を encode する", async () => {
    const mockFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(mockRepo));
    const client = new GitHubClientImpl(mockFetcher);

    await client.getRepository("token", "a?b", "c#d");

    expect(mockFetcher.mock.calls.at(0)?.[0]).toBe("https://api.github.com/repos/a%3Fb/c%23d");
  });
});

describe("GitHubClientImpl - getRepositoryById", () => {
  it("repository ID から現在の repository を parse して返す", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(mockRepo));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRepositoryById("token", 123)).resolves.toEqual(mockRepo);
    expect(fetcher.mock.calls.at(0)?.[0]).toBe("https://api.github.com/repositories/123");
  });

  it("installation から参照できない 404 を repo_not_found として返す", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRepositoryById("token", 123)).rejects.toMatchObject({
      type: "repo_not_found",
      statusCode: 404,
    });
  });

  it("不正な response shape を unexpected_github_error として返す", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 123, name: "partial" }));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRepositoryById("token", 123)).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });
});

describe("GitHubClientImpl - getPullRequest", () => {
  it("正常なレスポンスを parse して返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse(mockPullRequest));

    const result = await client.getPullRequest("token", "org", "repo", 1);

    expect(result.number).toBe(1);
    expect(result.title).toBe("feat: test");
    expect(result.merge_commit_sha).toBe("test-merge-sha");
    expect(result.head).toEqual(mockPullRequest.head);
  });

  it("fork の label を保持し、削除済み head repository の null も受け入れる", async () => {
    const head = { ...mockPullRequest.head, ref: "main", label: "alice:main", repo: null };
    const mockFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ ...mockPullRequest, head }));

    const result = await new GitHubClientImpl(mockFetcher).getPullRequest("token", "org", "repo", 1);

    expect(result.head).toEqual(head);
  });

  it("ISO datetime 以外の updated_at を拒否する", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ ...mockPullRequest, updated_at: "0" }));

    await expect(client.getPullRequest("token", "org", "repo", 1)).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });

  it("404 で pr_not_found エラーを投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404));

    await expect(client.getPullRequest("token", "org", "repo", 999)).rejects.toMatchObject({
      type: "pr_not_found",
      statusCode: 404,
    });
  });

  it("mergeable がない詳細レスポンスを拒否する", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(mockPullRequestSummary));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getPullRequest("token", "org", "repo", 1)).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });
});

describe("GitHubClientImpl - listOpenPullRequests", () => {
  it("mergeable がない一覧レスポンスを parse して返す", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse([mockPullRequestSummary]));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.listOpenPullRequests("token", "org", "repo")).resolves.toEqual([mockPullRequestSummary]);
  });
});

describe("GitHubClientImpl - mergePullRequest", () => {
  const mergeOptions = {
    commitTitle: "feat: merge",
    sha: "abc",
    mergeMethod: "squash" as const,
  };

  it("呼び出し元の merge 期限による abort を fetch に伝播する", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Merge deadline", "TimeoutError");
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected an AbortSignal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(reason);
          },
          { once: true }
        );
      });
    });
    const merging = new GitHubClientImpl(fetcher).mergePullRequest("token", "org", "repo", 1, {
      ...mergeOptions,
      signal: controller.signal,
    });
    controller.abort(reason);

    await expect(merging).rejects.toBe(reason);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("status 409 で head_sha_changed エラーを投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ message: "Conflict" }, 409));

    await expect(client.mergePullRequest("token", "org", "repo", 1, mergeOptions)).rejects.toMatchObject({
      type: "head_sha_changed",
    });
  });

  it("status 405 の merge conflict body で merge_conflict エラーを投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ message: "Pull Request is not mergeable" }, 405));

    await expect(client.mergePullRequest("token", "org", "repo", 1, mergeOptions)).rejects.toMatchObject({
      type: "merge_conflict",
    });
  });

  it("status 405 の branch protection body で merge_blocked エラーを投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(
      jsonResponse({ message: "Protected branch update failed for refs/heads/main." }, 405)
    );

    await expect(client.mergePullRequest("token", "org", "repo", 1, mergeOptions)).rejects.toMatchObject({
      type: "merge_blocked",
      statusCode: 409,
    });
  });

  it("merged: false のレスポンスで merge_conflict エラーを投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ sha: "abc", merged: false, message: "not merged" }));

    await expect(client.mergePullRequest("token", "org", "repo", 1, mergeOptions)).rejects.toMatchObject({
      type: "merge_conflict",
    });
  });

  it("head SHA を request body に指定して正常な merge レスポンスを返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ sha: "merge-sha", merged: true, message: "merged" }));

    const result = await client.mergePullRequest("token", "org", "repo", 1, mergeOptions);

    expect(mockFetcher.mock.calls.at(0)?.[1]?.body).toBe(
      JSON.stringify({
        commit_title: "feat: merge",
        sha: "abc",
        merge_method: "squash",
      })
    );
    expect(result.sha).toBe("merge-sha");
    expect(result.merged).toBe(true);
  });
});

describe("GitHubClientImpl - listWorkflowFiles", () => {
  it("指定した ref の .github/workflows 直下の path と sha を返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(
      jsonResponse([{ name: "ci.yml", path: ".github/workflows/ci.yml", sha: "ci-sha", type: "file" }])
    );

    await expect(client.listWorkflowFiles("token", "org", "repo", "head-sha")).resolves.toEqual([
      { path: ".github/workflows/ci.yml", sha: "ci-sha" },
    ]);
    expect(mockFetcher.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/org/repo/contents/.github/workflows?ref=head-sha"
    );
  });

  it("workflow の directory がない commit では空配列を返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    await expect(client.listWorkflowFiles("token", "org", "repo", "head-sha")).resolves.toEqual([]);
  });
});

describe("GitHubClientImpl - listPullRequestFilePaths", () => {
  it("全 page の file の path を、rename 前の path も含めて返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher
      .mockResolvedValueOnce(
        jsonResponse([{ filename: "docs/a.md" }], 200, {
          Link: '<https://api.github.com/repos/org/repo/pulls/1/files?page=2>; rel="next"',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([{ filename: "ci/build.yml", previous_filename: ".github/workflows/build.yml" }])
      );

    await expect(client.listPullRequestFilePaths("token", "org", "repo", 1)).resolves.toEqual([
      "docs/a.md",
      "ci/build.yml",
      ".github/workflows/build.yml",
    ]);
    expect(mockFetcher).toHaveBeenCalledTimes(2);
  });
});

describe("GitHubClientImpl - isOrgMember", () => {
  it("status 204 で true を返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await client.isOrgMember("token", "org", "alice");

    expect(result).toBe(true);
    expect(mockFetcher.mock.calls.at(0)?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("status 404 で false を返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const result = await client.isOrgMember("token", "org", "outsider");

    expect(result).toBe(false);
  });

  it("status 302 で false を返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const result = await client.isOrgMember("token", "org", "outsider");

    expect(result).toBe(false);
  });

  it("その他のステータスで GitHubError を投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    await expect(client.isOrgMember("token", "org", "alice")).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });

  it("org / username に URL 特殊文字を含む場合、fetch へ渡す URL を encode する", async () => {
    const mockFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new GitHubClientImpl(mockFetcher);

    await client.isOrgMember("token", "o rg", "a/b");

    expect(mockFetcher.mock.calls.at(0)?.[0]).toBe("https://api.github.com/orgs/o%20rg/members/a%2Fb");
  });
});

describe("GitHubClientImpl - approveWorkflowRun", () => {
  it("status 201 で true を返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response(null, { status: 201 }));

    const result = await client.approveWorkflowRun("token", "org", "repo", 1);

    expect(result).toBe(true);
  });

  it("status 403 で false を返し、GitHub が承認を拒否した理由を記録する", async () => {
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ message: "This run is not waiting for approval" }, 403));

    const result = await client.approveWorkflowRun("token", "org", "repo", 1);

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        event: "github_api_failed",
        context: "approveWorkflowRun org/repo#1",
        githubStatus: 403,
        githubMessage: "This run is not waiting for approval",
      })
    );
  });

  it("その他のステータスで GitHubError を投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    await expect(client.approveWorkflowRun("token", "org", "repo", 1)).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });
});

describe("GitHubClientImpl - listActionRequiredRuns", () => {
  it("正常なレスポンスから workflow_runs を返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    const workflowRuns = [{ id: 1, name: "CI", status: "action_required", actor: { login: "user" } }];
    mockFetcher.mockResolvedValueOnce(jsonResponse({ total_count: 1, workflow_runs: workflowRuns }));

    const result = await client.listActionRequiredRuns("token", "org", "repo", "abc123");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, name: "CI" });
    expect(mockFetcher.mock.calls.at(0)?.[0]).toBe(
      "https://api.github.com/repos/org/repo/actions/runs?head_sha=abc123&status=action_required&event=pull_request&per_page=100"
    );
  });

  it("失敗レスポンスで GitHubError を投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    mockFetcher.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    await expect(client.listActionRequiredRuns("token", "org", "repo", "abc123")).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });

  it("total_count: 100 かつ workflow_runs 100 件なら成功する", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    const workflowRuns = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `CI ${String(index + 1)}`,
      status: "action_required",
      actor: { login: "user" },
    }));
    mockFetcher.mockResolvedValueOnce(jsonResponse({ total_count: 100, workflow_runs: workflowRuns }));

    await expect(client.listActionRequiredRuns("token", "org", "repo", "abc123")).resolves.toHaveLength(100);
  });

  it("total_count: 101 かつ workflow_runs 100 件なら取得不足として fail-closed にする", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    const workflowRuns = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `CI ${String(index + 1)}`,
      status: "action_required",
      actor: { login: "user" },
    }));
    mockFetcher.mockResolvedValueOnce(jsonResponse({ total_count: 101, workflow_runs: workflowRuns }));
    vi.spyOn(logger, "log").mockImplementation(() => {
      // この test では log の出力を意図的に抑止する
    });

    await expect(client.listActionRequiredRuns("token", "org", "repo", "abc123")).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });
});

describe("GitHubClientImpl - getCombinedStatusForRef", () => {
  it("Combined Status を per_page=100 で取得する", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ state: "success", total_count: 0, statuses: [] }));
    const client = new GitHubClientImpl(fetcher);

    await client.getCombinedStatusForRef("token", "org", "repo", "sha");

    expect(fetcher.mock.calls.at(0)?.[0]).toBe("https://api.github.com/repos/org/repo/commits/sha/status?per_page=100");
  });

  it("total_count が取得件数を超える場合 unexpected_github_error エラーを投げる", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        state: "success",
        total_count: 101,
        statuses: [{ state: "success", context: "ci", target_url: null }],
      })
    );
    const client = new GitHubClientImpl(fetcher);

    const rejection = client.getCombinedStatusForRef("token", "org", "repo", "sha");

    await expect(rejection).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
    await expect(rejection).rejects.toThrow(/exceeds a single page/);
  });
});

const makeCheckRuns = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `CI-${String(i + 1)}`,
    status: "completed",
    conclusion: "success",
    html_url: null,
    app: { id: 123, slug: "github-actions" },
  }));

describe("GitHubClientImpl - listCheckRunsForRef", () => {
  it("正常なレスポンスを parse して返す", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    const checkRuns = makeCheckRuns(1);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ total_count: 1, check_runs: checkRuns }));

    const result = await client.listCheckRunsForRef("token", "org", "repo", "sha");

    expect(result.total_count).toBe(1);
    expect(result.check_runs).toHaveLength(1);
    expect(result.check_runs[0]?.app?.slug).toBe("github-actions");
  });

  it("total_count が取得件数を超える場合 unexpected_github_error エラーを投げる", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    const checkRuns = makeCheckRuns(1);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ total_count: 101, check_runs: checkRuns }));

    const rejection = client.listCheckRunsForRef("token", "org", "repo", "sha");

    await expect(rejection).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
    await expect(rejection).rejects.toThrow(/exceed a single page/);
  });

  it("total_count: 100 かつ check_runs 100件 では成功する（上限境界）", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    const checkRuns = makeCheckRuns(100);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ total_count: 100, check_runs: checkRuns }));

    const result = await client.listCheckRunsForRef("token", "org", "repo", "sha");

    expect(result.total_count).toBe(100);
    expect(result.check_runs).toHaveLength(100);
  });

  it("total_count: 101 かつ check_runs 100件 では reject する（上限境界）", async () => {
    const mockFetcher = vi.fn<typeof fetch>();
    const client = new GitHubClientImpl(mockFetcher);
    const checkRuns = makeCheckRuns(100);
    mockFetcher.mockResolvedValueOnce(jsonResponse({ total_count: 101, check_runs: checkRuns }));

    const rejection = client.listCheckRunsForRef("token", "org", "repo", "sha");

    await expect(rejection).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
    await expect(rejection).rejects.toThrow(/exceed a single page \(total=101, fetched=100\)/);
  });

  it("ref に URL 特殊文字を含む場合、fetch へ渡す URL を encode する", async () => {
    const mockFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ total_count: 0, check_runs: [] }));
    const client = new GitHubClientImpl(mockFetcher);

    await client.listCheckRunsForRef("token", "org", "repo", "re f");

    expect(mockFetcher.mock.calls.at(0)?.[0]).toBe(
      "https://api.github.com/repos/org/repo/commits/re%20f/check-runs?per_page=100"
    );
  });
});

describe("GitHubClientImpl - getRequiredStatusChecksForBranch", () => {
  it("effective Rulesets から context と integration_id を parse する", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        { type: "pull_request", parameters: { required_approving_review_count: 1 } },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "CI", integration_id: 123 },
              { context: "lint", integration_id: null },
              { context: "legacy-status" },
            ],
            strict_required_status_checks_policy: true,
          },
        },
      ])
    );
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRequiredStatusChecksForBranch("token", "org", "repo", "release/v1")).resolves.toEqual([
      { context: "CI", integrationId: 123 },
      { context: "lint", integrationId: null },
      { context: "legacy-status", integrationId: null },
    ]);
    expect(fetcher.mock.calls.at(0)?.[0]).toBe(
      "https://api.github.com/repos/org/repo/rules/branches/release%2Fv1?per_page=100&page=1"
    );
  });

  it("複数ページの effective rules を全て取得する", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "CI", integration_id: 123 }],
                strict_required_status_checks_policy: true,
              },
            },
          ],
          200,
          { link: '<https://api.github.com/rules?page=2>; rel="next"' }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "lint", integration_id: 456 }],
              strict_required_status_checks_policy: false,
            },
          },
        ])
      );
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRequiredStatusChecksForBranch("token", "org", "repo", "main")).resolves.toEqual([
      { context: "CI", integrationId: 123 },
      { context: "lint", integrationId: 456 },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.at(1)?.[0]).toContain("page=2");
  });

  it("required_status_checks rule がなければ空配列を返す", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([{ type: "pull_request" }]));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRequiredStatusChecksForBranch("token", "org", "repo", "main")).resolves.toEqual([]);
  });

  it("required_status_checks の shape が不正なら fail-closed にする", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "" }],
            strict_required_status_checks_policy: true,
          },
        },
      ])
    );
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRequiredStatusChecksForBranch("token", "org", "repo", "main")).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });

  it("Rules API の失敗を伝播して fail-closed にする", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "server error" }, 500));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRequiredStatusChecksForBranch("token", "org", "repo", "main")).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });

  it("private repository の plan 制限を専用エラーとして伝播する", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ message: "Upgrade to GitHub Pro or make this repository public to enable this feature." }, 403)
      );
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getRequiredStatusChecksForBranch("token", "org", "repo", "main")).rejects.toMatchObject({
      type: "github_rules_api_unavailable",
      statusCode: 409,
    });
  });
});

describe("GitHubClientImpl - permission エラーとレスポンス shape エラー", () => {
  it("permission 不足を github_app_permission_missing へ変換する", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "Forbidden" }, 403));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getPullRequest("token", "org", "repo", 1)).rejects.toMatchObject({
      type: "github_app_permission_missing",
      statusCode: 503,
    });
  });

  it("不正な response shape を unexpected_github_error へ変換する", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ unexpected: true }));
    const client = new GitHubClientImpl(fetcher);

    await expect(client.getPullRequest("token", "org", "repo", 1)).rejects.toMatchObject({
      type: "unexpected_github_error",
      statusCode: 502,
    });
  });
});
