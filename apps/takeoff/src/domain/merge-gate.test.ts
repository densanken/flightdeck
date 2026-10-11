import { describe, expect, it } from "vitest";

import {
  evaluateCheckRuns,
  evaluateChecksAndStatusGate,
  evaluateCombinedStatus,
  evaluateMergeGate as evaluateMergeGateAtTime,
  evaluatePullRequestGate as evaluatePullRequestGateAtTime,
  getFailedStatuses,
} from "./merge-gate.js";

import type {
  MergeGateCheckRun as GitHubCheckRun,
  MergeGateCombinedStatus as GitHubCombinedStatus,
  MergeGatePullRequest as GitHubPullRequest,
} from "./merge-gate.js";

const basePr: GitHubPullRequest = {
  title: "feat: add feature",
  updated_at: "2024-01-01T00:00:00Z",
  state: "open",
  draft: false,
  mergeable: true,
  head: { sha: "abc123" },
};

const now = "2024-01-01T00:01:00Z";
const evaluatePullRequestGate = (pr: GitHubPullRequest) => evaluatePullRequestGateAtTime(pr, now);
const evaluateMergeGate = (
  pr: GitHubPullRequest,
  checkRuns: GitHubCheckRun[],
  combinedStatus: GitHubCombinedStatus,
  requiredStatusChecks: Parameters<typeof evaluateMergeGateAtTime>[3]
) => evaluateMergeGateAtTime(pr, checkRuns, combinedStatus, requiredStatusChecks, now);

const emptyCheckRuns: GitHubCheckRun[] = [];
const successCheckRuns: GitHubCheckRun[] = [
  {
    name: "CI",
    status: "completed",
    conclusion: "success",
    html_url: null,
    app: { id: 123, slug: "github-actions" },
  },
];
const failedCheckRun: GitHubCheckRun = {
  name: "CI",
  status: "completed",
  conclusion: "failure",
  html_url: null,
  app: { id: 123 },
};
const failedCheckRuns = [failedCheckRun];
const pendingCheckRun: GitHubCheckRun = {
  name: "CI",
  status: "in_progress",
  conclusion: null,
  html_url: null,
  app: { id: 123 },
};
const pendingCheckRuns = [pendingCheckRun];
const skippedCheckRuns: GitHubCheckRun[] = [
  { name: "CI", status: "completed", conclusion: "skipped", html_url: null, app: { id: 123 } },
];
const requiredCi = [{ context: "CI", integrationId: 123 }];

const emptyStatus: GitHubCombinedStatus = { state: "pending", statuses: [] };
const successStatus: GitHubCombinedStatus = {
  state: "success",
  statuses: [{ state: "success", context: "ci", target_url: null }],
};
const failedStatus: GitHubCombinedStatus = {
  state: "failure",
  statuses: [{ state: "failure", context: "ci", target_url: null }],
};
const pendingStatus: GitHubCombinedStatus = {
  state: "pending",
  statuses: [{ state: "pending", context: "ci", target_url: null }],
};

describe("evaluateCheckRuns", () => {
  it("check run が 0 件なら通す", () => {
    expect(evaluateCheckRuns(emptyCheckRuns)).toEqual([]);
  });

  it("全て success なら通す", () => {
    expect(evaluateCheckRuns(successCheckRuns)).toEqual([]);
  });

  it("skipped も通す", () => {
    expect(evaluateCheckRuns(skippedCheckRuns)).toEqual([]);
  });

  it("failure の check を検出する", () => {
    const result = evaluateCheckRuns(failedCheckRuns);
    expect(result).toHaveLength(1);
    expect(result.at(0)?.name).toBe("CI");
  });

  it("pending の check を検出する", () => {
    const result = evaluateCheckRuns(pendingCheckRuns);
    expect(result).toHaveLength(1);
  });
});

describe("evaluateCombinedStatus", () => {
  it("status が 0 件なら通す", () => {
    expect(evaluateCombinedStatus(emptyStatus)).toEqual({
      passed: true,
      state: "none",
    });
  });

  it("success なら通す", () => {
    expect(evaluateCombinedStatus(successStatus)).toEqual({
      passed: true,
      state: "success",
    });
  });

  it("failure なら拒否する", () => {
    expect(evaluateCombinedStatus(failedStatus)).toEqual({
      passed: false,
      state: "failure",
    });
  });

  it("pending なら拒否する", () => {
    expect(evaluateCombinedStatus(pendingStatus)).toEqual({
      passed: false,
      state: "pending",
    });
  });

  it("失敗した status context の詳細を返す", () => {
    expect(getFailedStatuses(failedStatus)).toEqual([
      {
        context: "ci",
        state: "failure",
        targetUrl: null,
      },
    ]);
  });
});

describe("evaluatePullRequestGate", () => {
  it("更新から 59 秒では拒否し、60 秒で通す", () => {
    const recentlyUpdatedPr = { ...basePr, updated_at: "2024-01-01T00:00:01Z" };
    const blocked = evaluatePullRequestGateAtTime(recentlyUpdatedPr, now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.type).toBe("pr_recently_updated");
    expect(evaluatePullRequestGateAtTime(recentlyUpdatedPr, "2024-01-01T00:01:01Z")).toEqual({ ok: true });
  });

  it.each(["invalid date", "0", "2024-02-30T00:00:00Z", "2024-01-01T24:00:00Z"])(
    "now または updated_at が不正なら fail-closed にする (%s)",
    (invalidTimestamp) => {
      expect(evaluatePullRequestGateAtTime(basePr, invalidTimestamp)).toMatchObject({
        ok: false,
        error: { type: "pr_recently_updated" },
      });
      expect(evaluatePullRequestGateAtTime({ ...basePr, updated_at: invalidTimestamp }, now)).toMatchObject({
        ok: false,
        error: { type: "pr_recently_updated" },
      });
    }
  );

  it("parse 可能でも ISO datetime ではない updated_at は fail-closed にする", () => {
    expect(evaluatePullRequestGateAtTime({ ...basePr, updated_at: "2024" }, now)).toMatchObject({
      ok: false,
      error: { type: "pr_recently_updated" },
    });
  });

  it("有効な PR を通す", () => {
    expect(evaluatePullRequestGate(basePr)).toEqual({ ok: true });
  });

  it("closed な PR を拒否する", () => {
    const result = evaluatePullRequestGate({ ...basePr, state: "closed" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("pr_not_open");
  });

  it("draft な PR を拒否する", () => {
    const result = evaluatePullRequestGate({ ...basePr, draft: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("pr_is_draft");
  });

  it("draft marker 付き title を拒否する", () => {
    const result = evaluatePullRequestGate({ ...basePr, title: "[WIP] feat: work" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("pr_title_marked_draft");
  });

  it("Conventional PR Title 違反を拒否する", () => {
    const result = evaluatePullRequestGate({ ...basePr, title: "bad title" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid_pr_title");
  });

  it("mergeable は検査しない（null でも通す）", () => {
    expect(evaluatePullRequestGate({ ...basePr, mergeable: null })).toEqual({ ok: true });
  });
});

describe("evaluateChecksAndStatusGate", () => {
  it("Rules API が使えず check run と status が 0 件なら拒否する", () => {
    const result = evaluateChecksAndStatusGate(emptyCheckRuns, emptyStatus, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("checks_not_registered");
  });

  it("Rules API が使えない場合は GHA の Check Run があれば通す", () => {
    expect(evaluateChecksAndStatusGate(successCheckRuns, emptyStatus, null)).toEqual({ ok: true });
  });

  it("Rules API が使える場合も Bot の必須 check だけでは拒否する", () => {
    const botCheckRuns: GitHubCheckRun[] = [
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        html_url: null,
        app: { id: 123, slug: "example-bot" },
      },
    ];
    expect(evaluateChecksAndStatusGate(botCheckRuns, emptyStatus, requiredCi)).toMatchObject({
      ok: false,
      error: { type: "checks_not_registered" },
    });
  });

  it("Rules API が使えなくても GHA 以外の成功 check や status だけなら拒否する", () => {
    const botCheckRuns: GitHubCheckRun[] = [
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        html_url: null,
        app: { id: 123, slug: "example-bot" },
      },
    ];
    for (const [checkRuns, status] of [
      [botCheckRuns, emptyStatus],
      [emptyCheckRuns, successStatus],
      [botCheckRuns, successStatus],
    ] as const) {
      const result = evaluateChecksAndStatusGate([...checkRuns], status, null);
      expect(result).toMatchObject({ ok: false, error: { type: "checks_not_registered" } });
    }
  });

  it("Rules API が使えなくても Bot/App check の failure と pending は拒否する", () => {
    const botFailed = [{ ...failedCheckRun, app: { id: 123, slug: "example-bot" } }];
    const botPending = [{ ...pendingCheckRun, app: { id: 123, slug: "example-bot" } }];
    expect(evaluateChecksAndStatusGate(botFailed, emptyStatus, null)).toMatchObject({
      ok: false,
      error: { type: "checks_failed" },
    });
    expect(evaluateChecksAndStatusGate(botPending, emptyStatus, null)).toMatchObject({
      ok: false,
      error: { type: "checks_pending" },
    });
    expect(evaluateChecksAndStatusGate(emptyCheckRuns, failedStatus, null)).toMatchObject({
      ok: false,
      error: { type: "statuses_failed" },
    });
    expect(evaluateChecksAndStatusGate(emptyCheckRuns, pendingStatus, null)).toMatchObject({
      ok: false,
      error: { type: "statuses_pending" },
    });
  });

  it("required status checks rule がなければ fail-closed にする", () => {
    const result = evaluateChecksAndStatusGate(successCheckRuns, emptyStatus, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("required_checks_policy_missing");
  });

  it("failure の check があれば checks_failed を返す", () => {
    const result = evaluateChecksAndStatusGate(failedCheckRuns, emptyStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("checks_failed");
  });

  it("pending の check があれば checks_pending を返す", () => {
    const result = evaluateChecksAndStatusGate(pendingCheckRuns, emptyStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("checks_pending");
  });

  it("check は空でも status が pending なら statuses_pending を返す", () => {
    const result = evaluateChecksAndStatusGate(emptyCheckRuns, pendingStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("statuses_pending");
  });

  it("check は空でも status が failure なら statuses_failed を返す", () => {
    const result = evaluateChecksAndStatusGate(emptyCheckRuns, failedStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("statuses_failed");
  });

  it("check が success かつ status が success なら通す", () => {
    expect(evaluateChecksAndStatusGate(successCheckRuns, successStatus, requiredCi)).toEqual({ ok: true });
  });

  it("check の failure は status の判定より優先される", () => {
    const result = evaluateChecksAndStatusGate(failedCheckRuns, pendingStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("checks_failed");
  });

  it("required check が未発火なら fail-closed にする", () => {
    const result = evaluateChecksAndStatusGate(emptyCheckRuns, emptyStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("required_checks_missing");
      expect(result.error.details).toEqual({
        requiredChecks: [{ context: "CI", integrationId: 123, reason: "missing" }],
      });
    }
  });

  it("同名 check が別 GitHub App 由来なら fail-closed にする", () => {
    const wrongAppCheckRuns = successCheckRuns.map((checkRun) => ({ ...checkRun, app: { id: 999 } }));
    const result = evaluateChecksAndStatusGate(wrongAppCheckRuns, emptyStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("required_checks_missing");
      expect(result.error.details).toEqual({
        requiredChecks: [{ context: "CI", integrationId: 123, reason: "source_mismatch" }],
      });
    }
  });

  it("integration_id がない required context は status が満たしても GHA 0 件なら拒否する", () => {
    expect(
      evaluateChecksAndStatusGate(emptyCheckRuns, successStatus, [{ context: "ci", integrationId: null }])
    ).toMatchObject({ ok: false, error: { type: "checks_not_registered" } });
  });

  it("required でない既存 check の failure も引き続き block する", () => {
    const result = evaluateChecksAndStatusGate([...successCheckRuns, ...failedCheckRuns], emptyStatus, requiredCi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("checks_failed");
  });
});

describe("evaluateMergeGate", () => {
  it("有効な PR を merge 可と判定する", () => {
    const result = evaluateMergeGate(basePr, successCheckRuns, emptyStatus, requiredCi);
    expect(result).toEqual({ canMerge: true, headSha: "abc123" });
  });

  it("closed な PR を拒否する", () => {
    const result = evaluateMergeGate({ ...basePr, state: "closed" }, emptyCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("pr_not_open");
  });

  it("draft な PR を拒否する", () => {
    const result = evaluateMergeGate({ ...basePr, draft: true }, emptyCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("pr_is_draft");
  });

  it("draft marker 付き title を拒否する", () => {
    const result = evaluateMergeGate({ ...basePr, title: "[WIP] feat: work" }, emptyCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("pr_title_marked_draft");
  });

  it("Conventional PR Title 違反を拒否する", () => {
    const result = evaluateMergeGate({ ...basePr, title: "bad title" }, emptyCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("invalid_pr_title");
  });

  it("mergeable null なら mergeability_checking を返す", () => {
    const result = evaluateMergeGate({ ...basePr, mergeable: null }, emptyCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("mergeability_checking");
  });

  it("mergeable false なら merge_conflict を返す", () => {
    const result = evaluateMergeGate({ ...basePr, mergeable: false }, emptyCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("merge_conflict");
  });

  it("failure の check run があれば拒否する", () => {
    const result = evaluateMergeGate(basePr, failedCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("checks_failed");
  });

  it("pending の check run があれば拒否する", () => {
    const result = evaluateMergeGate(basePr, pendingCheckRuns, emptyStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("checks_pending");
  });

  it("failure の status があれば拒否する", () => {
    const result = evaluateMergeGate(basePr, emptyCheckRuns, failedStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) {
      expect(result.error.type).toBe("statuses_failed");
      expect(result.error.details).toEqual({
        state: "failure",
        failedStatuses: [{ context: "ci", state: "failure", targetUrl: null }],
      });
    }
  });

  it("pending の status があれば拒否する", () => {
    const result = evaluateMergeGate(basePr, emptyCheckRuns, pendingStatus, requiredCi);
    expect(result.canMerge).toBe(false);
    if (!result.canMerge) expect(result.error.type).toBe("statuses_pending");
  });

  it("check runs 全て success かつ status success なら merge 可", () => {
    const result = evaluateMergeGate(basePr, successCheckRuns, successStatus, requiredCi);
    expect(result).toEqual({ canMerge: true, headSha: "abc123" });
  });

  describe("Rules API が GitHub plan 制限で利用できない場合", () => {
    it("open、non-draft、有効な title、mergeable かつ全 check/status 成功なら merge 可", () => {
      expect(evaluateMergeGate(basePr, successCheckRuns, successStatus, null)).toEqual({
        canMerge: true,
        headSha: "abc123",
      });
    });

    it.each([
      [{ state: "closed" }, "pr_not_open"],
      [{ draft: true }, "pr_is_draft"],
      [{ title: "invalid title" }, "invalid_pr_title"],
      [{ mergeable: false }, "merge_conflict"],
    ] as const)("PR gate %j は %s で拒否する", (patch, expectedType) => {
      const result = evaluateMergeGate({ ...basePr, ...patch }, successCheckRuns, successStatus, null);
      expect(result.canMerge).toBe(false);
      if (!result.canMerge) expect(result.error.type).toBe(expectedType);
    });

    it.each([
      [failedCheckRuns, successStatus, "checks_failed"],
      [pendingCheckRuns, successStatus, "checks_pending"],
      [successCheckRuns, failedStatus, "statuses_failed"],
      [successCheckRuns, pendingStatus, "statuses_pending"],
    ] as const)("check/status gate は %s で拒否する", (checkRuns, status, expectedType) => {
      const result = evaluateMergeGate(basePr, [...checkRuns], status, null);
      expect(result.canMerge).toBe(false);
      if (!result.canMerge) expect(result.error.type).toBe(expectedType);
    });
  });
});
