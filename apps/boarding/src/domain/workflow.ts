export interface WorkflowRun {
  id: number;
  path: string;
  event: string;
  headSha: string;
  headRepositoryId: number | null;
  status: string;
  conclusion: string | null;
  actorId: number | null;
}

interface ApprovalResult {
  status: string;
  facts?: { otherPaths: readonly string[] } | undefined;
}

export const isContentOnlyAllowed = (result: ApprovalResult): boolean =>
  result.status === "allowed" && result.facts?.otherPaths.length === 0;

export const approvalRepositoryId = (input: {
  crossRepository: boolean;
  headRepositoryId: number | null;
  result: ApprovalResult;
}): number | null => (input.crossRepository && isContentOnlyAllowed(input.result) ? input.headRepositoryId : null);

export const approvalRuns = (
  runs: WorkflowRun[],
  input: { headSha: string; headRepositoryId: number; authorId: number }
): WorkflowRun[] =>
  runs.filter(
    (run) =>
      run.path === ".github/workflows/ci.yml" &&
      run.event === "pull_request" &&
      run.headSha === input.headSha &&
      run.headRepositoryId === input.headRepositoryId &&
      run.status === "completed" &&
      run.conclusion === "action_required" &&
      run.actorId === input.authorId
  );
