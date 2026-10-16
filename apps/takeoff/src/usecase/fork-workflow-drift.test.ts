import { describe, expect, it, vi } from "vitest";

import { detectForkWorkflowDrift } from "./fork-workflow-drift.js";
import { MockGitHubClient } from "./github.mock.js";

import type { GitHubPullRequest } from "./github.js";

const pr = (headRepoId: number | null): GitHubPullRequest => ({
  number: 61,
  title: "docs: update",
  html_url: "https://github.com/org/repo/pull/61",
  state: "open",
  draft: false,
  mergeable: true,
  head: { sha: "head-sha", ref: "main", label: "alice:main", repo: headRepoId === null ? null : { id: headRepoId } },
  base: { ref: "main", sha: "base-sha", repo: { id: 101 } },
  user: { login: "alice" },
  updated_at: "2026-01-01T00:00:00Z",
});

const ci = { path: ".github/workflows/ci.yml", sha: "ci-v1" };
const ciV2 = { ...ci, sha: "ci-v2" };

// head と base（branch 名で取得）の workflow と、PR の差分に含まれる path を設定する
const clientWith = (files: { head: (typeof ci)[]; base: (typeof ci)[]; changedPaths?: string[] }) => {
  const client = new MockGitHubClient();
  client.workflowFiles.set("head-sha", files.head);
  client.workflowFiles.set("main", files.base);
  client.pullRequestFilePaths = files.changedPaths ?? ["docs/readme.md"];
  return client;
};

describe("detectForkWorkflowDrift", () => {
  it("同じ repository の branch からの PR は workflow を取得せず none を返す", async () => {
    const client = new MockGitHubClient();
    const list = vi.spyOn(client, "listWorkflowFiles");

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(101))).resolves.toBe("none");
    expect(list).not.toHaveBeenCalled();
  });

  it("fork の head と base で workflow が一致するときは PR の差分を調べず none を返す", async () => {
    const client = clientWith({ head: [ci], base: [ci] });
    const files = vi.spyOn(client, "listPullRequestFilePaths");

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(202))).resolves.toBe("none");
    expect(files).not.toHaveBeenCalled();
  });

  it("base で変更された workflow に head が追従していなければ base_changed を返す", async () => {
    const client = clientWith({ head: [ci], base: [ciV2] });

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(202))).resolves.toBe("base_changed");
  });

  it("base で削除された workflow が head に残っているときも base_changed を返す", async () => {
    const old = { path: ".github/workflows/old.yml", sha: "old" };
    const client = clientWith({ head: [ci, old], base: [ci] });

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(202))).resolves.toBe("base_changed");
  });

  it("PR 自体が workflow を変更しているときは pr_changed を返す", async () => {
    const client = clientWith({
      head: [ciV2],
      base: [ci],
      changedPaths: ["docs/readme.md", ".github/workflows/ci.yml"],
    });
    const files = vi.spyOn(client, "listPullRequestFilePaths");

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(202))).resolves.toBe("pr_changed");
    expect(files).toHaveBeenCalledWith("token", "org", "repo", 61);
  });

  it("PR が変更した workflow と食い違っている workflow が別なら base_changed を返す", async () => {
    const deploy = { path: ".github/workflows/deploy.yml", sha: "deploy-v1" };
    const client = clientWith({
      head: [ciV2, deploy],
      base: [ciV2, { ...deploy, sha: "deploy-v2" }],
      changedPaths: [".github/workflows/ci.yml"],
    });

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(202))).resolves.toBe("base_changed");
  });

  it("subdirectory 内の workflow を PR が変更しているときも pr_changed を返す", async () => {
    const shared = { path: ".github/workflows/shared", sha: "tree-v1" };
    const client = clientWith({
      head: [{ ...shared, sha: "tree-v2" }],
      base: [shared],
      changedPaths: [".github/workflows/shared/build.yml"],
    });

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(202))).resolves.toBe("pr_changed");
  });

  it("head の repository が削除された fork PR も fork として調べる", async () => {
    const client = clientWith({ head: [], base: [ci] });

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(null))).resolves.toBe("base_changed");
  });

  it("workflow の取得に失敗したときは none を返す", async () => {
    const client = new MockGitHubClient();
    vi.spyOn(client, "listWorkflowFiles").mockRejectedValue(new Error("contents unavailable"));

    await expect(detectForkWorkflowDrift(client, "token", "org", "repo", pr(202))).resolves.toBe("none");
  });
});
