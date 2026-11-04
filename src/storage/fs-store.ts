import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type ChatEvent,
  chatEvent,
  chatOrder,
  type NewEvent,
} from "../conversation/events.ts";
import { applyEvents } from "../conversation/reducer.ts";
import {
  type ChatRef,
  type ChatStart,
  type ChatState,
  newChatState,
} from "../conversation/state.ts";
import type { ConversationStore, StoreHealth } from "../conversation/store.ts";
import type { Logger } from "../log/logger.ts";
import {
  appendEvents,
  readFolder,
  readState,
  writeChatTxt,
  writeState,
} from "./chat-folder.ts";
import { renderChat } from "./chat-txt.ts";
import { checkFolderName, checkWritable, listChatFolders } from "./data-dir.ts";
import { syncDir } from "./files.ts";
import { keyedLock } from "./lock.ts";

export interface FsStoreOptions {
  dataDir: string;
  /** Time zone of the times in chat.txt. */
  timeZone: string;
  now: () => number;
  logger: Logger;
  /** Start values of a chat that has no folder yet. */
  chatStart: (chat: ChatRef) => ChatStart;
}

interface Folder {
  connection: string;
  chatKey: string;
  /** `<connection>/<chatKey>` */
  id: string;
  dir: string;
}

interface Opened {
  state: ChatState;
  events: ChatEvent[];
  saved: boolean;
}

/** Checks the data directory, then loads every chat folder and applies events a crash left unapplied. */
export async function openFsStore(
  options: FsStoreOptions,
): Promise<ConversationStore> {
  await checkWritable(options.dataDir);
  const store = new FsStore(options);
  let chats = 0;
  for await (const _ of store.chats()) chats += 1;
  const damaged = store.health().damaged.length;
  options.logger.info({ chats, damaged }, "loaded chat records");
  return store;
}

class FsStore implements ConversationStore {
  readonly #options: FsStoreOptions;
  readonly #locked = keyedLock();
  readonly #damaged = new Map<string, string>();

  constructor(options: FsStoreOptions) {
    this.#options = options;
  }

  async *chats(): AsyncIterable<ChatRef> {
    for (const [connection, chatKey] of await listChatFolders(
      this.#options.dataDir,
    )) {
      const folder = this.#folder(connection, chatKey);
      const opened = await this.#locked(folder.id, () =>
        this.#open(folder).catch(() => undefined),
      );
      if (opened) yield opened.state.chat;
    }
  }

  async read(chat: ChatRef) {
    const folder = this.#folderOf(chat);
    const { state, events } = await this.#locked(folder.id, () =>
      this.#openChat(folder, chat),
    );
    return { state, events: events.toSorted(chatOrder) };
  }

  async append(chat: ChatRef, events: readonly NewEvent[]) {
    const folder = this.#folderOf(chat);
    return this.#locked(folder.id, async () => {
      const opened = await this.#openChat(folder, chat);
      const { added, duplicates } = number(
        opened.events,
        events,
        this.#options.now(),
      );
      if (added.length > 0) await this.#save(folder, opened, added);
      return { appended: added, duplicates };
    });
  }

  health(): StoreHealth {
    return {
      damaged: [...this.#damaged].map(([chat, reason]) => ({ chat, reason })),
    };
  }

  async #save(folder: Folder, opened: Opened, added: ChatEvent[]) {
    const { dir } = folder;
    if (!opened.saved) {
      // state.json comes first: it names the chat kind, which the folder path does not hold.
      await mkdir(dir, { recursive: true });
      await writeState(dir, opened.state);
    }
    await appendEvents(dir, added);
    const events = [...opened.events, ...added];
    // state.json comes last: until it is written, the next open replays the events and writes chat.txt again.
    await writeChatTxt(dir, renderChat(events, this.#options.timeZone));
    // Read again to keep an operator edit saved since the open.
    const current = (await readState(dir)) ?? opened.state;
    await writeState(dir, applyEvents(current, events));
    if (!opened.saved) {
      await syncDir(dir);
      await syncDir(dirname(dir));
      await syncDir(dirname(dirname(dir)));
    }
  }

  async #openChat(folder: Folder, chat: ChatRef): Promise<Opened> {
    const opened = await this.#open(folder);
    if (!opened) {
      const start = newChatState(chat, this.#options.chatStart(chat));
      return { state: start, events: [], saved: false };
    }
    if (opened.state.chat.kind !== chat.kind) {
      throw new Error(
        `Chat ${folder.id} belongs to a ${opened.state.chat.kind} connection, not ${chat.kind}`,
      );
    }
    return opened;
  }

  /** Undefined when the chat has no record yet. Records the chat as damaged when a file cannot be read. */
  async #open(folder: Folder): Promise<Opened | undefined> {
    try {
      const opened = await this.#load(folder);
      this.#damaged.delete(folder.id);
      return opened;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#damaged.set(folder.id, reason);
      this.#options.logger.error({ chat: folder.id, reason }, "damaged chat");
      throw new Error(`Chat ${folder.id} is damaged: ${reason}`, {
        cause: error,
      });
    }
  }

  async #load(folder: Folder): Promise<Opened | undefined> {
    const {
      state: saved,
      events,
      hasChatTxt,
    } = await readFolder(folder.dir, this.#options.logger);
    if (!saved) {
      if (events.length === 0) return undefined;
      throw new Error("state.json is missing");
    }
    const { connection, chatKey } = saved.chat;
    if (connection !== folder.connection || chatKey !== folder.chatKey) {
      throw new Error("state.json names a different chat");
    }
    if (saved.appliedSeq > events.length) {
      throw new Error(
        `state.json appliedSeq ${saved.appliedSeq} is after the last event ${events.length}`,
      );
    }
    // Events after appliedSeq were saved, but a crash stopped the update of chat.txt and state.json.
    const replay = saved.appliedSeq < events.length;
    if (replay || !hasChatTxt) {
      await writeChatTxt(
        folder.dir,
        renderChat(events, this.#options.timeZone),
      );
    }
    const state = applyEvents(saved, events);
    if (replay) await writeState(folder.dir, state);
    return { state, events, saved: true };
  }

  #folderOf(chat: ChatRef): Folder {
    checkFolderName(chat.connection, "Connection name");
    checkFolderName(chat.chatKey, "Chat key");
    return this.#folder(chat.connection, chat.chatKey);
  }

  #folder(connection: string, chatKey: string): Folder {
    const dir = join(this.#options.dataDir, connection, chatKey);
    return { connection, chatKey, id: `${connection}/${chatKey}`, dir };
  }
}

/** Gives new events their seq and record time, and leaves out events with a known dedupKey. */
function number(
  existing: readonly ChatEvent[],
  events: readonly NewEvent[],
  recordedAt: number,
): { added: ChatEvent[]; duplicates: number } {
  const keys = new Set(existing.map((event) => event.dedupKey));
  const added: ChatEvent[] = [];
  for (const event of events) {
    if (event.dedupKey !== undefined && keys.has(event.dedupKey)) continue;
    keys.add(event.dedupKey);
    const seq = existing.length + added.length + 1;
    added.push(chatEvent.parse({ ...event, seq, recordedAt }));
  }
  return { added, duplicates: events.length - added.length };
}
