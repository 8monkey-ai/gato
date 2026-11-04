import type { z } from "zod";

import {
  type AcceptResult,
  type InboundEvent,
  inboundEvent,
  type InboundSink,
} from "../channel/inbound.ts";
import type { Logger } from "../log/logger.ts";
import type { ChatEvent, DeliveryState, NewEvent } from "./events.ts";
import type { ChatRef } from "./state.ts";
import type { ConversationStore } from "./store.ts";

type Inbound = z.output<typeof inboundEvent>;
type Message = Extract<ChatEvent, { type: "message" }>;

interface InboundServiceOptions {
  store: ConversationStore;
  logger: Logger;
  /** Called once for each saved customer message. Outgoing traffic never calls it, so it cannot cause a reply loop. */
  onCustomerMessage?: (chat: ChatRef, message: Message) => void;
}

/** Saves what the adapters receive in the chat record. */
export function inboundService(options: InboundServiceOptions) {
  const { store, logger, onCustomerMessage } = options;

  async function accept(
    source: Omit<ChatRef, "chatKey">,
    input: InboundEvent,
  ): Promise<AcceptResult> {
    const parsed = inboundEvent.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "event"}: ${issue.message}`,
      );
      logger.warn({ issues }, "rejected a malformed inbound event");
      return "malformed";
    }
    const event = parsed.data;
    const chat = {
      kind: source.kind,
      connection: source.connection,
      chatKey: event.chatKey,
    };
    const record = await recordOf(store, chat, event);
    if (typeof record === "string") return record;
    const [saved] = (await store.append(chat, [record])).appended;
    if (!saved) return "duplicate";
    if (saved.type === "message" && saved.role === "customer") {
      onCustomerMessage?.(chat, saved);
    }
    return "saved";
  }

  return {
    /** The sink of one connection. Each event it accepts belongs to a chat of that connection. */
    sinkFor(source: Omit<ChatRef, "chatKey">): InboundSink {
      return { accept: (event) => accept(source, event) };
    },
  };
}

async function recordOf(
  store: ConversationStore,
  chat: ChatRef,
  event: Inbound,
): Promise<NewEvent | "duplicate" | "ignored"> {
  const { at, dedupKey } = event;
  switch (event.type) {
    case "message":
      return event.externalId
        ? reconcileEcho(store, chat, event, event.externalId)
        : message(event);
    case "delivery-update": {
      const known = await findMessage(store, chat, event.externalId);
      if (!known) return "ignored";
      const { messageId } = known;
      return {
        type: "message-update",
        at,
        dedupKey,
        messageId,
        delivery: event.delivery,
      };
    }
    case "owner":
      return {
        type: "owner",
        at,
        dedupKey,
        owner: event.owner,
        source: "channel",
      };
    case "status":
      return { type: "status", at, dedupKey, status: event.status };
    case "note":
      return {
        type: "note",
        at,
        dedupKey,
        kind: "comment",
        author: event.author,
        text: event.text,
      };
  }
}

function message(event: Extract<Inbound, { type: "message" }>): NewEvent {
  const { at, dedupKey, role, sender, parts, externalId } = event;
  return {
    type: "message",
    at,
    dedupKey,
    messageId: dedupKey,
    role,
    sender,
    parts,
    delivery: role === "customer" ? "received" : "confirmed",
    externalId,
  };
}

/** A message the record already holds is a repeat; it can only confirm an own send that was not confirmed. */
async function reconcileEcho(
  store: ConversationStore,
  chat: ChatRef,
  event: Extract<Inbound, { type: "message" }>,
  externalId: string,
): Promise<NewEvent | "duplicate"> {
  const known = await findMessage(store, chat, externalId);
  if (!known) return message(event);
  if (known.delivery === "confirmed" || known.delivery === "received") {
    return "duplicate";
  }
  return {
    type: "message-update",
    at: event.at,
    dedupKey: event.dedupKey,
    messageId: known.messageId,
    delivery: "confirmed",
  };
}

/** The message with this platform id, with its latest delivery state. */
// shortcut: reads the whole history for each externalId lookup; add an index when histories get large.
async function findMessage(
  store: ConversationStore,
  chat: ChatRef,
  externalId: string,
): Promise<{ messageId: string; delivery: DeliveryState } | undefined> {
  const { events } = await store.read(chat);
  const found = events.find(
    (event) => event.type === "message" && event.externalId === externalId,
  );
  if (found?.type !== "message") return undefined;
  const delivery = events.reduce(
    (latest, event) =>
      event.type === "message-update" &&
      event.messageId === found.messageId &&
      event.delivery
        ? event.delivery
        : latest,
    found.delivery,
  );
  return { messageId: found.messageId, delivery };
}
