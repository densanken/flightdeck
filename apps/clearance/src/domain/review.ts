import type { Actor, PolicyKind } from "@flightdeck/rules";

export interface Review {
  id: number | null;
  state: string;
  author: Actor | null;
  commitOid: string | null;
}

export type Decision =
  | { kind: "allowed"; policy: PolicyKind; headSha: string }
  | { kind: "skip" | "violated" | "undeterminable"; reasonCode: string };

export const reviewAction = (
  decision: Decision,
  latest: Review | undefined
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
