import type { ChannelMessage, ChatEvent, Inbox } from "../channels/channel.ts";
import { log } from "../log.ts";
import type { ChatState, MessageEntry } from "./entry.ts";
import { findMessage, insertEntry, messages, moveEntry } from "./record.ts";
import type { Conversation } from "./store.ts";
import { logFields, save } from "./store.ts";

interface InboxDeps {
  fail: (error: unknown) => void;
  conversation: (chat: string) => Conversation | undefined;
  retrieve: (conversation: Conversation) => void;
  customerWrote: (conversation: Conversation) => void;
  assignedToAgent: (conversation: Conversation) => void;
}

function applyState(state: ChatState, event: ChatEvent) {
  Object.assign(state, event.ownership);
  Object.assign(state.profile, event.profile);
  const remove = new Set(event.labels?.remove);
  state.labels = [
    ...new Set([...state.labels, ...(event.labels?.add ?? [])]),
  ].filter((label) => !remove.has(label));
}

function confirmEcho(conversation: Conversation, message: ChannelMessage) {
  const pending = messages(conversation.entries).find(
    (entry) =>
      entry.role === "agent" &&
      entry.ref === undefined &&
      entry.delivery !== "sent" &&
      entry.delivery !== "failed" &&
      entry.text === message.text,
  );
  const original = findMessage(conversation.entries, message.ref) ?? pending;
  if (!original) return false;
  original.ref = message.ref;
  original.delivery = "sent";
  moveEntry(conversation.entries, original, message.at.toISOString());
  return true;
}

function toEntry(message: ChannelMessage): MessageEntry {
  return {
    kind: "message",
    id: crypto.randomUUID(),
    at: message.at.toISOString(),
    role: message.role,
    ref: message.ref,
    text: message.text,
    sender: message.sender,
    attachments: message.attachments?.map((attachment) => ({
      id: crypto.randomUUID(),
      ...attachment,
    })),
    delivery: message.role === "agent" ? "sent" : undefined,
  };
}

function record(conversation: Conversation, message: ChannelMessage) {
  if (message.role === "agent" && confirmEcho(conversation, message))
    return undefined;
  if (findMessage(conversation.entries, message.ref)) return undefined;
  const entry = toEntry(message);
  insertEntry(conversation.entries, entry);
  return entry;
}

async function apply(conversation: Conversation, event: ChatEvent) {
  const wasAssigned = conversation.state.assignee === "agent";
  applyState(conversation.state, event);
  const added = event.message && record(conversation, event.message);
  if (added?.role === "customer") conversation.state.pendingReply = true;
  await save(conversation);
  return {
    added,
    assigned: !wasAssigned && conversation.state.assignee === "agent",
  };
}

export function createInbox(deps: InboxDeps): Inbox {
  return {
    fail: (error) => deps.fail(error),
    async handle(event) {
      const conversation = deps.conversation(event.chat);
      if (!conversation) return;
      const { added, assigned } = await apply(conversation, event);
      if (added) {
        const fields = logFields(conversation);
        log("info", "message.recorded", {
          ...fields,
          message: added.id,
          role: added.role,
        });
      }
      if (added?.attachments?.length) deps.retrieve(conversation);
      if (added?.role === "customer") deps.customerWrote(conversation);
      else if (assigned) deps.assignedToAgent(conversation);
    },
  };
}
