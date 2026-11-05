import type { Entry, MessageEntry } from "./entry.ts";

export function insertEntry(entries: Entry[], entry: Entry) {
  let index = entries.length;
  while (index > 0 && entries[index - 1]!.at > entry.at) index--;
  entries.splice(index, 0, entry);
}

export function moveEntry(entries: Entry[], entry: Entry, at: string) {
  entries.splice(entries.indexOf(entry), 1);
  entry.at = at;
  insertEntry(entries, entry);
}

export function messages(entries: Entry[]) {
  return entries.filter(
    (entry): entry is MessageEntry => entry.kind === "message",
  );
}

export function isVisible(entry: MessageEntry) {
  return entry.role !== "agent" || entry.delivery === "sent";
}

export function findMessage(entries: Entry[], ref: string) {
  return messages(entries).find((entry) => entry.ref === ref);
}

export function latestCustomerAt(entries: Entry[]) {
  return messages(entries)
    .filter((entry) => entry.role === "customer")
    .reduce<string | undefined>(
      (latest, entry) => (latest && latest > entry.at ? latest : entry.at),
      undefined,
    );
}

export function isAgentActivity(entry: Entry) {
  if (entry.kind === "note") return entry.byAgent === true;
  return (
    entry.kind === "message" &&
    entry.role === "agent" &&
    (entry.delivery === "sent" || entry.delivery === "uncertain")
  );
}

export function latestAgentActivityAt(entries: Entry[]) {
  return entries
    .filter(isAgentActivity)
    .reduce<string | undefined>(
      (latest, entry) => (latest && latest > entry.at ? latest : entry.at),
      undefined,
    );
}

export function awaitsReply(entries: Entry[]) {
  const visible = messages(entries).filter(isVisible);
  return visible.at(-1)?.role === "customer";
}
