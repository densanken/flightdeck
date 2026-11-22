import { STALE_MS, automergeDisabled } from "./policy.js";

import type { PolicyKind } from "./policy.js";
import type { PolicyPullRequest } from "./pull-request.js";

// 評価しても対象外のままと分かっている PR の branch を覚えておく port
export interface SkipCache {
  // branches の全部が、見送りの期限内なら true
  has: (repositoryId: number, branches: readonly string[]) => Promise<boolean>;
  remember: (repositoryId: number, branch: string, until: number, now: number) => Promise<void>;
}

// body の編集は pull_request の webhook で届くが、取りこぼしても 1 時間で評価し直す
const AUTOMERGE_SKIP_MS = 60 * 60 * 1000;

// この時刻（epoch ms）まで、評価しても対象外のままと分かる Renovate PR の期限
// 作成から 30 日経つまでは、body や CI に関係なく Merge も Approve もされない
// 対象外と言い切れない PR は undefined を返す
export const skipUntil = (
  policy: PolicyKind | null,
  pr: Pick<PolicyPullRequest, "state" | "createdAt" | "body">,
  now: number
): number | undefined => {
  if (policy !== "renovate-stale" || pr.state !== "OPEN") return undefined;

  const matured = Date.parse(pr.createdAt) + STALE_MS;
  if (matured > now) return matured;

  return automergeDisabled(pr.body) ? undefined : now + AUTOMERGE_SKIP_MS;
};
