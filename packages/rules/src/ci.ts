export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  app: { id: number; slug?: string } | null;
}

export interface CommitStatus {
  context: string;
  state: string;
}

export interface RequiredStatusCheck {
  context: string;
  integrationId: number | null;
}

type CiDecision = "passed" | "pending" | "blocked";

// head と potentialMergeCommit の結果は呼び出し側で合わせる
export const evaluateCi = (
  checks: CheckRun[],
  statuses: CommitStatus[],
  required: RequiredStatusCheck[]
): CiDecision => {
  // clearance は失敗で Approve を撤回するため、pending を優先する takeoff と異なり確定した失敗を先に判定する
  if (
    checks.some(
      (check) => check.status === "completed" && check.conclusion !== "success" && check.conclusion !== "skipped"
    )
  ) {
    return "blocked";
  }
  if (statuses.some((status) => status.state !== "success" && status.state !== "pending")) return "blocked";

  if (checks.some((check) => check.status !== "completed")) return "pending";
  if (statuses.some((status) => status.state === "pending")) return "pending";

  // integration_id を指定した必須 check は、その App の Check Run だけで満たす
  const missing = required.some((item) => {
    const matchingCheck = checks.some(
      (check) => check.name === item.context && (item.integrationId === null || check.app?.id === item.integrationId)
    );

    return (
      !matchingCheck && !(item.integrationId === null && statuses.some((status) => status.context === item.context))
    );
  });
  if (missing) return "blocked";

  // PR Title の status だけでは成功にしない
  return checks.some((check) => check.app?.slug === "github-actions") ? "passed" : "pending";
};
