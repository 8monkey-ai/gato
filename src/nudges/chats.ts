import type { ChatStore } from "../storage/chat-store.ts";

export const healthyChats = (store: Pick<ChatStore, "list" | "isDamaged">) =>
  store.list().filter((ref) => !store.isDamaged(ref));
