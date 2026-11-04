import type { ChatEvent, DeliveryState, Role } from "../conversation/events.ts";
import { chatOrder } from "../conversation/events.ts";
import { localDateTime } from "../time/zone.ts";

type Message = Extract<ChatEvent, { type: "message" }>;
type Note = Extract<ChatEvent, { type: "note" }>;

const roleName: Record<Role, string> = {
  customer: "Customer",
  operator: "Operator",
  workflow: "Workflow",
  agent: "Agent",
};

/** Lines for the messages and notes in chat order, each with its latest delivery state. */
export function renderChat(events: readonly ChatEvent[], zone: string): string {
  const delivery = latestDelivery(events);
  return events
    .filter(rendered)
    .toSorted(chatOrder)
    .map((event) => {
      const text = `${heading(event, delivery)}: ${body(event)}`;
      return `[${localDateTime(event.at, zone)}] ${text.replaceAll("\n", "\n  ")}\n`;
    })
    .join("");
}

function rendered(event: ChatEvent): event is Message | Note {
  return event.type === "message" || event.type === "note";
}

function latestDelivery(
  events: readonly ChatEvent[],
): Map<string, DeliveryState> {
  const delivery = new Map<string, DeliveryState>();
  for (const event of events) {
    if (event.type === "message") delivery.set(event.messageId, event.delivery);
    if (event.type === "message-update" && event.delivery) {
      delivery.set(event.messageId, event.delivery);
    }
  }
  return delivery;
}

function heading(
  event: Message | Note,
  delivery: Map<string, DeliveryState>,
): string {
  if (event.type === "note") {
    return `Internal note (${event.kind}, by ${event.author})`;
  }
  if (event.internalTrigger) return `Internal ${event.internalTrigger} trigger`;
  const state = delivery.get(event.messageId) ?? event.delivery;
  const shown =
    state === "received" || state === "confirmed" ? "" : ` [${state}]`;
  return `${roleName[event.role]}${sender(event.sender)}${shown}`;
}

function sender({ name, known }: Message["sender"]): string {
  if (name === undefined) return known ? "" : " (unknown sender)";
  return known ? ` (${name})` : ` (${name}, unconfirmed)`;
}

function body(event: Message | Note): string {
  return event.type === "note"
    ? event.text
    : event.parts.map((part) => part.text).join("\n");
}
