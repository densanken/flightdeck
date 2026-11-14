import type { PolicyKind } from "@flightdeck/rules";

export type MergeDecision =
  { action: "merge"; policy: PolicyKind; headSha: string } | { action: "wait" | "skip" | "block"; reasonCode: string };
