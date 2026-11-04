import { expect, test } from "bun:test";

import { BudgetExceededError, createBudget } from "./budget.ts";

test("allows the configured number of model calls, then throws", () => {
  const budget = createBudget({ timeoutMs: 60_000, maxModelCalls: 2 });
  budget.take();
  expect(budget.remainingCalls()).toBe(1);
  budget.take();
  expect(budget.remainingCalls()).toBe(0);
  expect(() => budget.take()).toThrow(BudgetExceededError);
  expect(budget.signal.aborted).toBe(false);
  budget.dispose();
});

test("a call after the deadline aborts the signal with reason timed-out", () => {
  let clock = 1_000;
  const budget = createBudget(
    { timeoutMs: 500, maxModelCalls: 5 },
    undefined,
    () => clock,
  );
  budget.take();
  clock = 1_500;
  expect(() => budget.take()).toThrow();
  expect(budget.signal.reason).toBe("timed-out");
  expect(budget.remainingCalls()).toBe(4);
  budget.dispose();
});

test("the deadline timer aborts the signal without a call", async () => {
  const budget = createBudget({ timeoutMs: 0, maxModelCalls: 5 });
  await new Promise((resolve) =>
    budget.signal.addEventListener("abort", resolve),
  );
  expect(budget.signal.reason).toBe("timed-out");
  budget.dispose();
});

test("a parent abort keeps the parent reason", () => {
  const parent = new AbortController();
  const budget = createBudget(
    { timeoutMs: 60_000, maxModelCalls: 5 },
    parent.signal,
  );
  parent.abort("interrupted");
  expect(budget.signal.reason).toBe("interrupted");
  expect(() => budget.take()).toThrow();
  budget.dispose();
});
