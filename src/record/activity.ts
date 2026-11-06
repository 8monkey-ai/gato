import type { Entry, MessageEntry, TurnEntry } from "./entries.ts";

const finalStatuses = new Set(["completed", "skipped", "failed", "timed-out"]);

function customerMessages(entries: readonly Entry[]): MessageEntry[] {
  return entries.filter(
    (entry): entry is MessageEntry =>
      entry.type === "message" && entry.role === "customer",
  );
}

/**
 * Customer messages that wait for an answer. A newer message that arrived
 * while a human owned the conversation cancels the wait.
 */
export function pendingMessages(entries: readonly Entry[]): MessageEntry[] {
  const answered = new Set(
    entries.flatMap((entry) =>
      entry.type === "turn" && finalStatuses.has(entry.status)
        ? entry.covers
        : [],
    ),
  );
  const customer = customerMessages(entries);
  const latest = customer.at(-1);
  if (!latest?.trigger || answered.has(latest.id)) return [];
  return customer.filter(
    (message) => message.trigger && !answered.has(message.id),
  );
}

export function latestCustomerActivity(
  entries: readonly Entry[],
): Date | undefined {
  const latest = customerMessages(entries).at(-1);
  return latest && new Date(latest.at);
}

/** Agent messages that may have reached the customer and agent-authored notes. */
export function latestAgentActivity(
  entries: readonly Entry[],
): Date | undefined {
  const latest = entries.findLast(
    (entry) =>
      (entry.type === "message" &&
        entry.role === "agent" &&
        entry.delivery !== "failed") ||
      (entry.type === "note" && entry.author === "agent"),
  );
  return latest && new Date(latest.at);
}

export function unfinishedTurns(entries: readonly Entry[]): TurnEntry[] {
  return entries.filter(
    (entry): entry is TurnEntry =>
      entry.type === "turn" && entry.status === "running",
  );
}
