import { randomUUID } from "node:crypto";

import type { InboundEvent, InboundSink } from "../channels/channel.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatMessage, ChatRef } from "../record/types.ts";
import type { ChatSession, ChatStore } from "../storage/chat-store.ts";
import type { Controls } from "./controls.ts";
import { type ChatState, sameState } from "./ownership.ts";

type EventOf<K extends InboundEvent["kind"]> = Extract<
  InboundEvent,
  { kind: K }
>;
type FollowUp = () => unknown;

const echoWindowMs = 10 * 60_000;

const pendingFirst = (m: ChatMessage) => (m.delivery === "pending" ? 0 : 1);

// A pending part is the likelier origin of an echo than an uncertain one, and a newer part than an older one.
function unconfirmedPartWithText(
  view: ChatView,
  text: string | undefined,
  now: Date,
) {
  return view.messages
    .filter(
      (m) =>
        m.author.role === "agent" &&
        (m.delivery === "pending" || m.delivery === "uncertain") &&
        m.platformId === undefined &&
        text !== undefined &&
        m.text === text &&
        now.getTime() - Date.parse(m.sentAt) <= echoWindowMs,
    )
    .sort(
      (a, b) =>
        pendingFirst(a) - pendingFirst(b) ||
        Date.parse(b.sentAt) - Date.parse(a.sentAt),
    )[0];
}

async function recordMessage(
  session: ChatSession,
  event: EventOf<"message">,
  now: Date,
) {
  const { message, eventId } = event;
  const view = session.view();
  const sentAt = message.sentAt.toISOString();
  const known = view.messageIdByPlatformId.get(message.platformId);
  const isAgent = message.author.role === "agent";
  const echoOf = known ?? unconfirmedPartWithText(view, message.text, now)?.id;
  if (isAgent && echoOf) {
    await session.append([
      {
        type: "message-update",
        messageId: echoOf,
        delivery: "sent",
        sentAt,
        platformId: message.platformId,
        eventId,
      },
    ]);
    return undefined;
  }
  if (known) return undefined;
  const added: ChatMessage = {
    id: randomUUID(),
    platformId: message.platformId,
    author: message.author,
    sentAt,
    text: message.text,
    attachments: message.attachments.map((a, i) => ({ id: `a${i + 1}`, ...a })),
    delivery: "observed",
  };
  await session.append([{ type: "message", message: added, eventId }]);
  return added;
}

type Context = {
  store: ChatStore;
  controls: Pick<Controls, "state">;
  log: Logger;
  now: () => Date;
  onCustomerMessage: (ref: ChatRef) => unknown;
  onNewAttachments: (ref: ChatRef) => unknown;
  onStateChange: (
    ref: ChatRef,
    previous: ChatState,
    current: ChatState,
  ) => unknown;
};

async function recordState(
  ctx: Context,
  ref: ChatRef,
  session: ChatSession,
  event: EventOf<"ownership" | "status">,
): Promise<FollowUp[]> {
  const previous = await ctx.controls.state(ref);
  const eventAt = event.at.toISOString();
  const { eventId } = event;
  await session.append([
    event.kind === "ownership"
      ? {
          type: "ownership",
          owner: event.owner,
          assigneeId: event.assigneeId,
          eventAt,
          eventId,
        }
      : { type: "status", open: event.open, eventAt, eventId },
  ]);
  const current = await ctx.controls.state(ref);
  return sameState(previous, current)
    ? []
    : [() => ctx.onStateChange(ref, previous, current)];
}

async function record(
  ctx: Context,
  ref: ChatRef,
  session: ChatSession,
  event: InboundEvent,
): Promise<FollowUp[]> {
  if (session.view().seenEventIds.has(event.eventId)) return [];
  if (event.kind !== "message") return recordState(ctx, ref, session, event);
  const added = await recordMessage(session, event, ctx.now());
  if (added)
    ctx.log.info("message.accepted", {
      ...ref,
      messageId: added.id,
      platformId: added.platformId,
      eventId: event.eventId,
      role: added.author.role,
    });
  return [
    ...(added?.attachments.length ? [() => ctx.onNewAttachments(ref)] : []),
    ...(added?.author.role === "customer"
      ? [() => ctx.onCustomerMessage(ref)]
      : []),
  ];
}

export function createIngest(ctx: Context) {
  return {
    sinkFor:
      (connectionId: string): InboundSink =>
      async (event) => {
        const ref = { connectionId, chatId: event.chatId };
        const followUps = await ctx.store.withChat(ref, (session) =>
          record(ctx, ref, session, event),
        );
        for (const followUp of followUps)
          void Promise.resolve()
            .then(followUp)
            .catch((error: unknown) =>
              ctx.log.error("ingest.follow_up_failed", { ...ref, error }),
            );
      },
  };
}
