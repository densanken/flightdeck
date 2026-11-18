import { describe, expect, it, vi } from "vitest";

import { WorkflowUseCaseImpl } from "./impl.js";

import type { PullRequestData } from "../evaluate/dependencies.js";
import type { EvaluationResult } from "../evaluate/interface.js";

const pr: PullRequestData = {
  state: "OPEN",
  baseBranch: "main",
  baseSha: "base",
  headSha: "sha",
  isCrossRepository: true,
  headRepositoryId: 2,
  author: { id: 3, login: "alice" },
  files: [],
  commits: [],
  reviews: [],
  baseRoots: [],
  mergeData: { body: "", draft: false, ci: null },
};
const result: EvaluationResult = {
  status: "allowed",
  reason: "AUTHORIZED",
  facts: { authorRoots: ["alice"], otherPaths: [], invalidCommits: [] },
};
const run = {
  id: 1,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  headSha: "sha",
  headRepositoryId: 2,
  status: "completed",
  conclusion: "action_required",
  actorId: 3,
};

describe("WorkflowUseCaseImpl", () => {
  it("対象 Run だけを取得して承認する", async () => {
    const list = vi.fn().mockResolvedValue([run, { ...run, actorId: 4 }]);
    const approve = vi.fn();
    await new WorkflowUseCaseImpl({ list, approve }).execute(pr, result);
    expect(list).toHaveBeenCalledWith("sha");
    expect(approve).toHaveBeenCalledWith([run]);
  });

  it("条件に合う Run がなければ承認を呼ばない", async () => {
    const list = vi.fn().mockResolvedValue([{ ...run, actorId: 4 }]);
    const approve = vi.fn();
    await new WorkflowUseCaseImpl({ list, approve }).execute(pr, result);
    expect(list).toHaveBeenCalledWith("sha");
    expect(approve).not.toHaveBeenCalled();
  });

  it("同一リポジトリや認可されない PR の Run を照会しない", async () => {
    const list = vi.fn();
    const approve = vi.fn();
    const usecase = new WorkflowUseCaseImpl({ list, approve });
    await usecase.execute({ ...pr, isCrossRepository: false }, result);
    await usecase.execute(pr, { status: "waiting", reason: "EDITOR_APPROVAL_MISSING" });
    expect(list).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });
});
