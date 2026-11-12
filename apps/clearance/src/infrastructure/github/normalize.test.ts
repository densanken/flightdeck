import { evaluateCi } from "@flightdeck/rules";
import { describe, expect, it } from "vitest";

import { normalizeConfigs, normalizePr } from "./normalize.js";
import { prResponse } from "./schema.js";

const makeResponse = () => ({
  repository: {
    databaseId: 1,
    pullRequest: {
      state: "OPEN",
      isDraft: false,
      body: "",
      createdAt: "2026-01-01T00:00:00Z",
      headRefName: "branch",
      headRefOid: "head",
      baseRefName: "main",
      author: null,
      editor: null,
      lastEditedAt: null,
      headRepository: { databaseId: 1 },
      labels: { totalCount: 0, nodes: [] },
      files: { totalCount: 0, nodes: [] },
      latestOpinionatedReviews: { totalCount: 0, nodes: [] },
      latestReviews: { totalCount: 0, nodes: [] },
      commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { contexts: { totalCount: 0, nodes: [] } } } }] },
      potentialMergeCommit: null,
      baseRef: {
        target: { oid: "base", submodules: { nodes: [], pageInfo: { hasNextPage: false } } },
      },
      recent: { pageCount: 0 },
      timelineItems: { pageCount: 0, pageInfo: { hasPreviousPage: false }, nodes: [] },
    },
  },
});

describe("PR connection の完全性", () => {
  it("timeline の pageCount と取得件数が一致すれば受け入れる", () => {
    const data = makeResponse();
    const response = {
      ...data.repository.pullRequest,
      timelineItems: {
        pageCount: 1,
        pageInfo: { hasPreviousPage: false },
        nodes: [{ __typename: "Other" }],
      },
    };
    const pr = prResponse.parse({ repository: { databaseId: 1, pullRequest: response } }).repository.pullRequest;

    if (!pr) throw new Error("missing fixture");

    expect(normalizePr(pr).timeline).toEqual([{ kind: "other" }]);
  });

  it("timeline の pageCount と取得件数が異なる場合は拒否する", () => {
    const data = makeResponse();

    data.repository.pullRequest.timelineItems.pageCount = 1;

    const pr = prResponse.parse(data).repository.pullRequest;

    if (!pr) throw new Error("missing fixture");

    expect(() => normalizePr(pr)).toThrow("truncated");
  });

  it("設定の不在と読めない blob を区別する", () => {
    expect(normalizeConfigs({ yml: null, yaml: null })).toEqual([]);
    expect(
      normalizeConfigs({ yml: { isBinary: false, isTruncated: false, text: "autopilot: {}" }, yaml: null })
    ).toEqual([{ path: ".github/flightdeck.yml", text: "autopilot: {}" }]);
    expect(normalizeConfigs({ yml: {}, yaml: null })).toEqual([{ path: ".github/flightdeck.yml", text: null }]);
  });

  it("files、reviews、labels、contexts の取得不足を拒否する", () => {
    for (const field of ["files", "latestReviews", "latestOpinionatedReviews", "labels"] as const) {
      const data = makeResponse();
      data.repository.pullRequest[field].totalCount = 1;
      const pr = prResponse.parse(data).repository.pullRequest;
      expect(pr).not.toBeNull();
      if (pr) expect(() => normalizePr(pr)).toThrow("truncated");
    }

    const data = makeResponse();
    const head = data.repository.pullRequest.commits.nodes[0];

    if (!head) throw new Error("missing fixture");
    head.commit.statusCheckRollup.contexts.totalCount = 1;

    const pr = prResponse.parse(data).repository.pullRequest;

    if (!pr) throw new Error("missing fixture");

    expect(() => normalizePr(pr)).toThrow("truncated");
  });

  it("切り詰められた submodule 一覧を記録する", () => {
    const data = makeResponse();

    data.repository.pullRequest.baseRef.target.submodules.pageInfo.hasNextPage = true;

    const pr = prResponse.parse(data).repository.pullRequest;

    if (!pr) throw new Error("missing fixture");

    expect(normalizePr(pr).submodulesComplete).toBe(false);
  });

  it("head と test merge commit の CI 結果を合わせる", () => {
    const data = makeResponse();
    const head = data.repository.pullRequest.commits.nodes[0];

    if (!head) throw new Error("missing fixture");

    const check = (conclusion: string) => ({
      __typename: "CheckRun",
      name: "ci",
      status: "COMPLETED",
      conclusion,
      checkSuite: { app: { databaseId: 1, slug: "github-actions" } },
    });
    const response = {
      repository: {
        ...data.repository,
        pullRequest: {
          ...data.repository.pullRequest,
          commits: {
            nodes: [
              {
                commit: {
                  ...head.commit,
                  statusCheckRollup: { contexts: { totalCount: 1, nodes: [check("SUCCESS")] } },
                },
              },
            ],
          },
          potentialMergeCommit: {
            oid: "merge",
            statusCheckRollup: { contexts: { totalCount: 1, nodes: [check("FAILURE")] } },
          },
        },
      },
    };
    const pr = prResponse.parse(response).repository.pullRequest;

    if (!pr) throw new Error("missing fixture");

    const normalized = normalizePr(pr);

    expect(evaluateCi(normalized.checks, normalized.statuses, [])).toBe("blocked");
  });

  it("GraphQL の取得中に変化した head を拒否する", () => {
    const data = makeResponse();

    data.repository.pullRequest.headRefOid = "other";

    const pr = prResponse.parse(data).repository.pullRequest;

    if (!pr) throw new Error("missing fixture");

    expect(() => normalizePr(pr)).toThrow("head incomplete");
  });
});
