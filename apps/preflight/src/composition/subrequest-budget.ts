import { SubrequestBudgetExceededError } from "../errors.js";

import type { CacheStorageLike } from "../repository/delivery/impl.js";
import type { Logger } from "../util/logger.js";

export type SubrequestPurpose = "normal" | "sweep" | "recovery" | "recovery_status";

const SUBREQUEST_LIMIT = 50;
const STATUS_RESERVE = 3;
const RECOVERY_RESERVE = 7;

export const createSubrequestBudget = (logger: Logger, deliveryId: string) => {
  const limits: Record<SubrequestPurpose, number> = {
    normal: SUBREQUEST_LIMIT,
    sweep: 16,
    recovery: RECOVERY_RESERVE,
    recovery_status: STATUS_RESERVE,
  };
  const used: Record<SubrequestPurpose, number> = { normal: 0, sweep: 0, recovery: 0, recovery_status: 0 };
  let statusReserve = STATUS_RESERVE;
  let recoveryReserve = RECOVERY_RESERVE;

  const effectiveLimit = (purpose: SubrequestPurpose): number => {
    const otherUsed = Object.entries(used).reduce((total, [key, count]) => total + (key === purpose ? 0 : count), 0);
    const reserve =
      (purpose === "recovery_status" ? 0 : Math.max(0, statusReserve - used.recovery_status)) +
      (purpose === "recovery" ? 0 : Math.max(0, recoveryReserve - used.recovery));
    return Math.max(0, Math.min(limits[purpose], SUBREQUEST_LIMIT - reserve - otherUsed));
  };

  const remaining = (purpose: SubrequestPurpose): number => Math.max(0, effectiveLimit(purpose) - used[purpose]);

  const consume = (purpose: SubrequestPurpose): void => {
    if (remaining(purpose) <= 0) {
      const error = new SubrequestBudgetExceededError(purpose, used[purpose], effectiveLimit(purpose));
      logger.log("warn", {
        event: "github_webhook_consume",
        result: "subrequest_budget_exceeded",
        deliveryId,
        subrequestPurpose: purpose,
        subrequestsUsed: error.used,
        subrequestLimit: error.limit,
      });
      throw error;
    }

    used[purpose] += 1;
  };

  return {
    consume,
    remaining,
    releaseReserves: () => {
      statusReserve = 0;
      recoveryReserve = 0;
    },
  };
};

export const budgetedCacheStorage = (
  storage: CacheStorageLike,
  budget: ReturnType<typeof createSubrequestBudget>
): CacheStorageLike => ({
  open: async (name) => {
    const cache = await storage.open(name);
    return {
      match: (request) => {
        budget.consume("normal");
        return cache.match(request);
      },
      put: (request, response) => {
        budget.consume("normal");
        return cache.put(request, response);
      },
    };
  },
});
