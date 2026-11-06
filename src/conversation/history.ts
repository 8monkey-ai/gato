import type { Entry, MessageEntry } from "../record/chat-file.ts";

export const isMessage = (entry: Entry): entry is MessageEntry =>
  entry.kind === "message";

export function isVisible(entry: Entry): entry is MessageEntry {
  if (!isMessage(entry)) return false;
  return (
    entry.role !== "agent" ||
    entry.delivery === "sent" ||
    entry.delivery === "confirmed"
  );
}

export function latestCustomerAt(
  entries: readonly Entry[],
): number | undefined {
  const latest = entries.findLast((e) => isMessage(e) && e.role === "customer");
  return latest && Date.parse(latest.at);
}

export function agentActivity(entries: readonly Entry[]): number[] {
  return entries
    .filter(
      (e) =>
        (e.kind === "note" && e.author === "agent") ||
        (isMessage(e) &&
          e.role === "agent" &&
          e.delivery !== "failed" &&
          e.delivery !== "unsent"),
    )
    .map((e) => Date.parse(e.at));
}
