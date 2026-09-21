import { describe, expect, it, vi } from "vitest";

import { addPullRequestAuthorAsAssignee } from "./pull-request-assignee.js";

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const input = (fetchImpl: typeof fetch, author = "author") => ({
  owner: "owner",
  repo: "repo",
  pullRequestNumber: 7,
  author,
  installationToken: "installation-token",
  fetchImpl,
  signal: new AbortController().signal,
});

describe("addPullRequestAuthorAsAssignee", () => {
  it("作成者だけを assignee に追加し、owner と repo を encode した URL へ送る", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ assignees: [{ login: "OctoCat" }, { login: "existing-user" }] }, 201));

    await expect(
      addPullRequestAuthorAsAssignee({
        ...input(fetchImpl, "octocat"),
        owner: "owner name",
        repo: "repo/name",
      })
    ).resolves.toEqual({ assigned: true, assignees: ["OctoCat", "existing-user"] });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/repos/owner%20name/repo%2Fname/issues/7/assignees");
    expect(typeof init?.body).toBe("string");
    const requestBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    expect(requestBody).toEqual({ assignees: ["octocat"] });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer installation-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("GitHub が黙って無視した assign 不可の作成者を assigned: false で返す", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ assignees: [{ login: "existing-user" }] }, 201));

    await expect(addPullRequestAuthorAsAssignee(input(fetchImpl, "outside-user"))).resolves.toEqual({
      assigned: false,
      assignees: ["existing-user"],
    });
  });

  it("201 以外の status と不正な response を GITHUB_API_FAILED で reject する", async () => {
    const failedFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "forbidden" }, 403));
    await expect(addPullRequestAuthorAsAssignee(input(failedFetch))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
      githubStatus: 403,
    });

    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ assignees: [{}] }, 201));
    await expect(addPullRequestAuthorAsAssignee(input(malformedFetch))).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });
});
