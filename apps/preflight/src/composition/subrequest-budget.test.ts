import { describe, expect, it, vi } from "vitest";

import { createSubrequestBudget } from "./subrequest-budget.js";
import { SubrequestBudgetExceededError } from "../errors.js";

describe("subrequest budget", () => {
  it("reserves independent limits and logs a refusal", () => {
    const logger = { log: vi.fn() };
    const { consume } = createSubrequestBudget(logger, "delivery");
    for (let i = 0; i < 24; i += 1) consume("normal");
    expect(() => {
      consume("normal");
    }).toThrow(SubrequestBudgetExceededError);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        result: "subrequest_budget_exceeded",
        subrequestPurpose: "normal",
        subrequestsUsed: 24,
        subrequestLimit: 24,
      })
    );
    for (const [purpose, limit] of [
      ["sweep", 16],
      ["recovery", 7],
      ["recovery_status", 3],
    ] as const) {
      for (let i = 0; i < limit; i += 1) consume(purpose);
      expect(() => {
        consume(purpose);
      }).toThrow(SubrequestBudgetExceededError);
    }
  });
});
