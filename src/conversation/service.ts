import type { Connection, IncomingMessage } from "../channels/channel.ts";
import { log } from "../log.ts";
import type { Entry, MessageEntry } from "../record/chat-file.ts";
import type { Conversation, ConversationStore } from "../record/store.ts";
import { ensureFiles } from "./files.ts";
import { isMessage } from "./history.ts";
import { createTurnQueue, type RunTurn } from "./turn-queue.ts";

export function createConversationService(
  store: ConversationStore,
  runTurn: RunTurn,
) {
  const turns = createTurnQueue(runTurn);
  const background = new Set<Promise<void>>();

  const receive = async (connection: Connection, message: IncomingMessage) => {
    const conversation = store.get(connection.id, message.contact);
    const entry = await record(conversation, message, () => {
      if (message.role === "customer") turns.interrupt(conversation);
    });
    if (!entry) return;
    log.info("message.recorded", {
      connection: connection.id,
      contact: message.contact,
      ref: message.ref,
      role: message.role,
    });
    const followUp = ensureFiles(conversation, connection, entry).then(() => {
      if (message.role === "customer")
        turns.request(conversation, connection, "customer");
    });
    background.add(followUp);
    void followUp.finally(() => background.delete(followUp));
  };

  return {
    receive,
    requestTurn: turns.request,
    isBusy: turns.isBusy,
    stop: async (graceMs: number) => {
      await Promise.all([turns.stop(graceMs), ...background]);
    },
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;

function record(
  conversation: Conversation,
  message: IncomingMessage,
  onNew: () => void,
) {
  return conversation.lock(async (edit) => {
    const echo =
      edit.entries.find((e) => isMessage(e) && e.ref === message.ref) ??
      (message.role === "agent"
        ? findUnconfirmed(edit.entries, message)
        : undefined);
    if (echo) {
      if (
        isMessage(echo) &&
        echo.role === "agent" &&
        echo.delivery !== "confirmed"
      ) {
        echo.delivery = "confirmed";
        echo.ref = message.ref;
        await edit.save();
      }
      return undefined;
    }
    onNew();
    const entry = toEntry(message);
    edit.add(entry);
    await edit.save().catch((error: unknown) => {
      edit.remove(entry);
      throw error;
    });
    return entry;
  });
}

function toEntry(message: IncomingMessage): MessageEntry {
  return {
    kind: "message",
    role: message.role,
    at: message.at.toISOString(),
    ref: message.ref,
    ...(message.sender ? { sender: message.sender } : {}),
    ...(message.text ? { text: message.text } : {}),
    ...(message.attachments.length
      ? { attachments: message.attachments.map((a) => ({ ...a })) }
      : {}),
    ...(message.role === "agent" ? { delivery: "confirmed" as const } : {}),
  };
}

function findUnconfirmed(entries: readonly Entry[], message: IncomingMessage) {
  return entries.find(
    (e) =>
      isMessage(e) &&
      e.role === "agent" &&
      !e.ref &&
      e.delivery === "uncertain" &&
      (e.text ?? "") === (message.text ?? ""),
  );
}
