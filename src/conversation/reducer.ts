import type { ChatEvent, DeliveryState, Role } from "./events.ts";
import type { ChatState } from "./state.ts";

type Activity = keyof ChatState["activity"];
type Message = Extract<ChatEvent, { type: "message" }>;

const activityOf: Record<Role, Activity> = {
  customer: "lastCustomerAt",
  operator: "lastOperatorAt",
  workflow: "lastWorkflowAt",
  agent: "lastAgentAt",
};

/** Messages in these delivery states are part of the conversation the customer sees. */
const seen = new Set<DeliveryState>(["received", "confirmed", "uncertain"]);

/**
 * Applies the events of `record` after `state.appliedSeq`, in record order.
 * `record` holds the chat's earlier events too, so an update finds its message.
 * Event kinds without an effect on state only move appliedSeq.
 */
export function applyEvents(
  state: ChatState,
  record: readonly ChatEvent[],
): ChatState {
  const messages = new Map<string, Message>();
  for (const event of record) {
    if (event.type === "message") messages.set(event.messageId, event);
  }
  return record
    .filter((event) => event.seq > state.appliedSeq)
    .reduce(
      (current, event) => ({
        ...effect(current, event, messages),
        appliedSeq: event.seq,
      }),
      state,
    );
}

function effect(
  state: ChatState,
  event: ChatEvent,
  messages: ReadonlyMap<string, Message>,
): ChatState {
  switch (event.type) {
    case "message":
      return messageActivity(state, event, event.delivery);
    case "message-update":
      return messageActivity(
        state,
        messages.get(event.messageId),
        event.delivery,
      );
    case "note":
      return event.author === "agent"
        ? advance(state, "lastAgentAt", event.at)
        : state;
    case "owner":
      return event.at < state.owner.at
        ? state
        : {
            ...state,
            owner: { kind: event.owner, at: event.at, source: event.source },
          };
    case "status":
      return event.at < state.statusAt
        ? state
        : { ...state, status: event.status, statusAt: event.at };
    case "label":
      return { ...state, labels: applyLabel(state.labels, event) };
    default:
      return state;
  }
}

function messageActivity(
  state: ChatState,
  message: Message | undefined,
  delivery: DeliveryState | undefined,
): ChatState {
  // An internal trigger only asks the agent to continue. It is not activity of any participant.
  if (!message || message.internalTrigger) return state;
  if (!delivery || !seen.has(delivery)) return state;
  return advance(state, activityOf[message.role], message.at);
}

function advance(state: ChatState, key: Activity, at: number): ChatState {
  const current = state.activity[key];
  if (current !== undefined && current >= at) return state;
  return { ...state, activity: { ...state.activity, [key]: at } };
}

function applyLabel(
  labels: string[],
  event: Extract<ChatEvent, { type: "label" }>,
): string[] {
  if (event.action === "remove") {
    return labels.filter((label) => label !== event.label);
  }
  return labels.includes(event.label) ? labels : [...labels, event.label];
}
