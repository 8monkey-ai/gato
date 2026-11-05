import type { Conversation } from "./store.ts";
import { isSafeName, newConversation } from "./store.ts";

export class DamagedHistory extends Error {}

const key = (connection: string, chat: string) => `${connection}/${chat}`;

export interface Damaged {
  connection: string;
  chat: string;
  error: string;
}

export function createConversations(
  dataDir: string,
  loaded: Conversation[],
  damaged: Damaged[],
) {
  const byKey = new Map(
    loaded.map((conversation) => [
      key(conversation.connection, conversation.chat),
      conversation,
    ]),
  );
  const damagedKeys = new Set(
    damaged.map((item) => key(item.connection, item.chat)),
  );
  return {
    get(connection: string, chat: string) {
      if (!isSafeName(chat))
        throw new Error(`Unsafe chat identifier for connection ${connection}.`);
      const id = key(connection, chat);
      if (damagedKeys.has(id))
        throw new DamagedHistory(
          `The history of ${id} is damaged. Repair its chat folder.`,
        );
      let conversation = byKey.get(id);
      if (!conversation) {
        conversation = newConversation(dataDir, connection, chat);
        byKey.set(id, conversation);
      }
      return conversation;
    },
    all() {
      return [...byKey.values()];
    },
    damaged,
  };
}

export type Conversations = ReturnType<typeof createConversations>;
