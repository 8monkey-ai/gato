export class BudgetExceededError extends Error {
  constructor(maxModelCalls: number) {
    super(`The turn used all ${maxModelCalls} model calls`);
    this.name = "BudgetExceededError";
  }
}

export type TurnBudget = ReturnType<typeof createBudget>;

export function createBudget(
  limits: { timeoutMs: number; maxModelCalls: number },
  parent?: AbortSignal,
  now: () => number = Date.now,
) {
  const deadline = now() + limits.timeoutMs;
  const own = new AbortController();
  const expire = () => own.abort("timed-out");
  const timer = setTimeout(expire, limits.timeoutMs);
  const signal = parent ? AbortSignal.any([parent, own.signal]) : own.signal;
  let taken = 0;
  return {
    signal,
    take() {
      if (now() >= deadline) expire();
      signal.throwIfAborted();
      if (taken >= limits.maxModelCalls)
        throw new BudgetExceededError(limits.maxModelCalls);
      taken += 1;
    },
    remainingCalls: () => limits.maxModelCalls - taken,
    dispose: () => clearTimeout(timer),
  };
}
