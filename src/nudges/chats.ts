import type { ChatRef } from "../record/types.ts";
import { folderName } from "../storage/chat-files.ts";
import type { ChatStore } from "../storage/chat-store.ts";

export const chatKey = (ref: ChatRef) =>
  `${ref.connectionId}/${folderName(ref.chatId)}`;

export function healthyChats(store: Pick<ChatStore, "list" | "damaged">) {
  const damaged = new Set(store.damaged().map((c) => chatKey(c.ref)));
  return store.list().filter((ref) => !damaged.has(chatKey(ref)));
}
