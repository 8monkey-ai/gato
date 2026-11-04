import type { DeliveryResult } from "../delivery/deliver.ts";
import type { TurnEnd } from "../record/types.ts";
import { BudgetExceededError } from "./budget.ts";
import type { Generation } from "./turn-generate.ts";

export type End = { outcome: TurnEnd; reason?: string };

const workLimit: End = { outcome: "failed", reason: "work limit reached" };

export function abortEnd(
  signal: AbortSignal,
  budgetSignal: AbortSignal,
): End | undefined {
  if (signal.aborted)
    return signal.reason === "shutdown"
      ? { outcome: "interrupted", reason: "shutdown" }
      : { outcome: "interrupted" };
  if (budgetSignal.aborted)
    return { outcome: "timed-out", reason: "time limit reached" };
  return undefined;
}

export function errorEnd(error: unknown): End {
  if (error instanceof BudgetExceededError) return workLimit;
  const reason = error instanceof Error ? error.message : String(error);
  return { outcome: "failed", reason };
}

export function resultEnd(
  generation: Generation & { handedOff: boolean },
  delivery: DeliveryResult,
): End {
  if (generation.limitReached) return workLimit;
  if (delivery.failed) return { outcome: "failed", reason: "delivery failed" };
  if (!generation.wroteText && !generation.handedOff)
    return { outcome: "skipped", reason: "no reply generated" };
  return { outcome: "completed" };
}
