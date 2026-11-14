import type { PolicyDecision, PolicyReview } from "@flightdeck/rules";

export const reviewAction = (
  decision: PolicyDecision,
  latest: PolicyReview | undefined
): "approve" | "dismiss" | "already_approved" | "missing_id" | "none" => {
  if (decision.kind === "allowed") {
    return latest?.state === "APPROVED" && latest.commitOid === decision.headSha ? "already_approved" : "approve";
  }
  // commit_id に関係なく、残っている自身の Approve を撤回する
  if (decision.kind === "violated" && latest?.state === "APPROVED") {
    return latest.id === null ? "missing_id" : "dismiss";
  }

  return "none";
};
