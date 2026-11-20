import { describe, expect, it, vi } from "vitest";

import { createSubrequestBudget } from "./subrequest-budget.js";
import { SubrequestBudgetExceededError } from "../errors.js";

describe("subrequest budget", () => {
  it("shares the normal and sweep pool while reserving recovery", () => {
    const logger = { log: vi.fn() };
    const { consume } = createSubrequestBudget(logger, "delivery");
    for (let i = 0; i < 16; i += 1) consume("sweep");
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
      ["recovery", 7],
      ["recovery_status", 3],
    ] as const) {
      for (let i = 0; i < limit; i += 1) consume(purpose);
      expect(() => {
        consume(purpose);
      }).toThrow(SubrequestBudgetExceededError);
    }
  });

  it("reports the purpose limit when it is smaller than the shared pool", () => {
    const logger = { log: vi.fn() };
    const budget = createSubrequestBudget(logger, "delivery");
    for (let i = 0; i < 16; i += 1) budget.consume("sweep");
    expect(() => {
      budget.consume("sweep");
    }).toThrow(SubrequestBudgetExceededError);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ subrequestsUsed: 16, subrequestLimit: 16 })
    );
  });

  it("uses spare normal budget for recovery without consuming the status reserve", () => {
    const budget = createSubrequestBudget({ log: vi.fn() }, "delivery");
    for (let i = 0; i < 7; i += 1) budget.consume("recovery");
    expect(budget.remaining("recovery")).toBe(0);
    expect(budget.remaining("recovery_status")).toBe(3);
    expect(budget.remaining("normal")).toBe(40);
  });

  it("releases the remaining reserves only after validation completes", () => {
    const budget = createSubrequestBudget({ log: vi.fn() }, "delivery");
    for (let i = 0; i < 40; i += 1) budget.consume("normal");
    expect(budget.remaining("normal")).toBe(0);
    expect(budget.remaining("recovery_status")).toBe(3);
    expect(budget.remaining("recovery")).toBe(7);
    budget.releaseReserves();
    for (let i = 0; i < 10; i += 1) budget.consume("normal");
    expect(budget.remaining("normal")).toBe(0);
    expect(budget.remaining("recovery_status")).toBe(0);
  });

  it("does not reserve recovery requests again after they are used", () => {
    const budget = createSubrequestBudget({ log: vi.fn() }, "delivery");
    for (let i = 0; i < 4; i += 1) budget.consume("recovery");
    for (let i = 0; i < 40; i += 1) budget.consume("normal");
    expect(budget.remaining("normal")).toBe(0);
    expect(budget.remaining("recovery")).toBe(3);
    expect(budget.remaining("recovery_status")).toBe(3);
  });
});
