import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { RecordedMessage } from "../record/projection.ts";
import type { Attachment, ChatMessage, ChatRef } from "../record/types.ts";
import type { ChatStore, NewEntry } from "../storage/chat-store.ts";

type Store = Pick<
  ChatStore,
  | "load"
  | "withChat"
  | "fileExists"
  | "writeTextFile"
  | "attachmentPath"
  | "saveAttachment"
>;
type Copy = { store: Store; from: ChatRef; into: ChatRef };

async function copyAttachment(
  { store, from, into }: Copy,
  attachment: Attachment,
  prefix: string,
): Promise<Attachment> {
  if (!attachment.file) return { ...attachment };
  const bytes = await fs.readFile(store.attachmentPath(from, attachment.file));
  const name = `${prefix}${path.basename(attachment.file)}`;
  return { ...attachment, file: await store.saveAttachment(into, name, bytes) };
}

async function copyMessage(
  copy: Copy,
  message: RecordedMessage,
  id: string,
): Promise<ChatMessage> {
  const prefix = id === message.id ? "" : `${id}-`;
  return {
    id,
    platformId: message.platformId,
    author: message.author,
    sentAt: message.sentAt,
    text: message.text,
    attachments: await Promise.all(
      message.attachments.map((a) => copyAttachment(copy, a, prefix)),
    ),
    delivery: message.delivery,
    error: message.error,
  };
}

async function refuseReason(store: Store, from: ChatRef, into: ChatRef) {
  if (from.connectionId !== into.connectionId)
    return "Both chats must belong to the same connection";
  if (from.chatId === into.chatId) return "A chat cannot be merged into itself";
  if ((await store.load(from)).lastSeq === 0)
    return `Unknown chat: ${from.chatId}`;
  if (await store.fileExists(from, "merged-into"))
    return `Chat ${from.chatId} is already merged`;
  return undefined;
}

// Copies the record only; past actions are not replayed and copied messages create no new work.
export async function mergeChats(store: Store, from: ChatRef, into: ChatRef) {
  const refused = await refuseReason(store, from, into);
  if (refused) throw new Error(refused);
  const source = await store.load(from);
  await store.withChat(into, async (session) => {
    const target = session.view();
    const ids = new Set(target.messages.map((m) => m.id));
    const entries: NewEntry[] = [];
    for (const message of source.messages) {
      const known = message.platformId;
      if (known && target.messageIdByPlatformId.has(known)) continue;
      const id = ids.has(message.id) ? randomUUID() : message.id;
      ids.add(id);
      const copied = await copyMessage({ store, from, into }, message, id);
      entries.push({ type: "message", message: copied });
    }
    await session.append([
      ...entries,
      { type: "merge", fromChatId: from.chatId },
    ]);
  });
  await store.writeTextFile(from, "merged-into", `${into.chatId}\n`);
}
