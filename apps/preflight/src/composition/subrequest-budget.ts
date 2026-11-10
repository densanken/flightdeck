import { SubrequestBudgetExceededError } from "../errors.js";

import type { CacheStorageLike } from "../repository/delivery/impl.js";
import type { Logger } from "../util/logger.js";

export type SubrequestPurpose = "normal" | "sweep" | "recovery" | "recovery_status";

export const createSubrequestBudget = (logger: Logger, deliveryId: string) => {
  const limits: Record<SubrequestPurpose, number> = { normal: 24, sweep: 16, recovery: 7, recovery_status: 3 };
  const used: Record<SubrequestPurpose, number> = { normal: 0, sweep: 0, recovery: 0, recovery_status: 0 };

  const consume = (purpose: SubrequestPurpose): void => {
    if (used[purpose] >= limits[purpose]) {
      const error = new SubrequestBudgetExceededError(purpose, used[purpose], limits[purpose]);
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

  return { consume, remaining: (purpose: SubrequestPurpose) => limits[purpose] - used[purpose] };
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
