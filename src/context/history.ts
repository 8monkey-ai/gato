import type { ChatView, RecordedMessage } from "../record/projection.ts";
import type { Delivery, Entry } from "../record/types.ts";
import { recentMonthStart } from "../summary/policy.ts";

type EntryOf<T extends Entry["type"]> = Extract<Entry, { type: T }>;

export type HistoryItem =
  | { kind: "message"; message: RecordedMessage }
  | { kind: "tool"; call: EntryOf<"tool-call">; result: EntryOf<"tool-result"> }
  | { kind: "trigger"; trigger: EntryOf<"trigger"> };

export type HistoryOptions = {
  scope: "chat" | "recent-month";
  includeToolActivity: boolean;
  now: Date;
  timeZone: string;
};

type Placed = { time: string; seq: number; item: HistoryItem };

const visibleAgentDelivery: readonly Delivery[] = ["sent", "observed"];

function isVisible(message: RecordedMessage): boolean {
  return message.author.role === "agent"
    ? visibleAgentDelivery.includes(message.delivery)
    : message.delivery === "observed";
}

function toolPairs(view: ChatView): Placed[] {
  const results = new Map<string, EntryOf<"tool-result">>();
  for (const entry of view.toolActivity)
    if (entry.type === "tool-result")
      results.set(`${entry.turnId}/${entry.callId}`, entry);
  return view.toolActivity.flatMap((call) => {
    if (call.type !== "tool-call") return [];
    const result = results.get(`${call.turnId}/${call.callId}`);
    return result
      ? [{ time: call.at, seq: call.seq, item: { kind: "tool", call, result } }]
      : [];
  });
}

function placedItems(view: ChatView, includeToolActivity: boolean): Placed[] {
  const messages = view.messages.filter(isVisible).map((message): Placed => ({
    time: message.sentAt,
    seq: message.seq,
    item: { kind: "message", message },
  }));
  if (!includeToolActivity) return messages;
  const triggers = view.triggers.map((trigger): Placed => ({
    time: trigger.at,
    seq: trigger.seq,
    item: { kind: "trigger", trigger },
  }));
  return [...messages, ...toolPairs(view), ...triggers];
}

export function selectHistory(
  view: ChatView,
  options: HistoryOptions,
): HistoryItem[] {
  const start =
    options.scope === "recent-month"
      ? recentMonthStart(options.now, options.timeZone).getTime()
      : -Infinity;
  return placedItems(view, options.includeToolActivity)
    .filter((placed) => Date.parse(placed.time) >= start)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.seq - b.seq)
    .map((placed) => placed.item);
}
