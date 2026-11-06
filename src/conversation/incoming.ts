import type { IncomingMessage } from "../channels/channel.ts";
import type { MessageEntry } from "../record/entries.ts";
import type { Chat } from "../record/store.ts";

function sameContent(entry: MessageEntry, message: IncomingMessage) {
  if (entry.video) return message.attachments[0]?.source === entry.text;
  return entry.text.trim() === message.text.trim();
}

function ownSend(
  chat: Chat,
  message: IncomingMessage,
): MessageEntry | undefined {
  return chat.entries.find(
    (entry): entry is MessageEntry =>
      entry.type === "message" &&
      entry.role === "agent" &&
      (entry.delivery === "sending" || entry.delivery === "uncertain") &&
      sameContent(entry, message),
  );
}

/**
 * Stores an incoming message once. A channel echo of an agent send updates
 * the original record. Returns true when the message is new customer input.
 */
export async function recordIncoming(
  chat: Chat,
  message: IncomingMessage,
): Promise<boolean> {
  if (chat.entries.some((e) => e.type === "message" && e.ref === message.ref))
    return false;
  const echo = message.role === "agent" && ownSend(chat, message);
  if (echo) {
    await chat.update<MessageEntry>(echo, {
      delivery: "sent",
      ref: message.ref,
    });
    return false;
  }
  await chat.add({
    type: "message",
    at: message.at.toISOString(),
    role: message.role,
    ...(message.sender !== undefined && { sender: message.sender }),
    text: message.text,
    ...(message.attachments.length && {
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
    }),
    ref: message.ref,
    ...(message.role === "agent" && { delivery: "sent" as const }),
    ...(message.role === "customer" && message.answerable && { trigger: true }),
  });
  return message.role === "customer";
}

/** After a restart, unfinished work is abandoned and sends without a known outcome stay unsent. */
export async function settleAfterRestart(chat: Chat): Promise<number> {
  let settled = 0;
  for (const entry of chat.entries) {
    if (entry.type === "turn" && entry.status === "running") {
      await chat.update(entry, {
        status: "interrupted",
        reason: "abandoned at restart",
      });
      settled++;
    }
    if (entry.type === "message" && entry.delivery === "sending") {
      await chat.update<MessageEntry>(entry, { delivery: "uncertain" });
      settled++;
    }
  }
  return settled;
}
