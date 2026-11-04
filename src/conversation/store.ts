import type { ChatEvent, NewEvent } from "./events.ts";
import type { ChatRef, ChatState } from "./state.ts";

/** The lasting record of all chats. One instance owns the storage. */
export interface ConversationStore {
  /** Chats with a readable record. Damaged chats are left out and reported by `health`. */
  chats(): AsyncIterable<ChatRef>;
  /** Reads the state again on each call, so manual edits by operators apply. Events are in chat order. */
  read(chat: ChatRef): Promise<{ state: ChatState; events: ChatEvent[] }>;
  /** Saves durably before it resolves. An event with a known `dedupKey` is counted, not saved again. */
  append(
    chat: ChatRef,
    events: readonly NewEvent[],
  ): Promise<{ appended: ChatEvent[]; duplicates: number }>;
  health(): StoreHealth;
}

export interface StoreHealth {
  /** `chat` is `<connection>/<chatKey>`. */
  damaged: Array<{ chat: string; reason: string }>;
}
