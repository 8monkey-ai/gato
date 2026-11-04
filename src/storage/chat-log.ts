import fs from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../log.ts";
import { type ChatView, project } from "../record/projection.ts";
import { renderChat } from "../record/render.ts";
import type { ChatRef, Entry, EntryBody } from "../record/types.ts";
import {
  appendDurable,
  folderName,
  parseEntries,
  readOptional,
  subdirectories,
  writeAtomic,
} from "./chat-files.ts";

export type NewEntry = EntryBody & { eventId?: string };
export type ChatSession = {
  view(): ChatView;
  append(bodies: NewEntry[]): Promise<ChatView>;
};
export type ChatLogOptions = {
  timeZone: string;
  log: Logger;
  now?: () => Date;
};

type Chat = {
  ref: ChatRef;
  dir: string;
  entries: Entry[];
  view: ChatView;
  endsWithNewline: boolean;
};

const keyOf = (ref: ChatRef) => `${ref.connectionId}/${folderName(ref.chatId)}`;

async function loadChats(dataDir: string, log: Logger) {
  const chats = new Map<string, Chat>();
  const damaged: { ref: ChatRef; error: string }[] = [];
  for (const connectionId of await subdirectories(dataDir)) {
    for (const chatId of await subdirectories(
      path.join(dataDir, connectionId),
    )) {
      const dir = path.join(dataDir, connectionId, chatId);
      const text = await readOptional(path.join(dir, "events.jsonl"));
      if (text === undefined) continue;
      const ref = { connectionId, chatId };
      const { entries, errors, endsWithNewline } = parseEntries(text);
      for (const error of errors) {
        damaged.push({ ref, error });
        log.error("chat.damaged", { connectionId, chatId, error });
      }
      chats.set(keyOf(ref), {
        ref,
        dir,
        entries,
        view: project(entries),
        endsWithNewline,
      });
    }
  }
  return { chats, damaged };
}

function createMutex() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return result;
  };
}

async function appendEntries(
  chat: Chat,
  bodies: NewEntry[],
  { timeZone, now = () => new Date() }: ChatLogOptions,
) {
  if (bodies.length === 0) return chat.view;
  const at = now().toISOString();
  const added = bodies.map((body, i): Entry => ({
    ...body,
    seq: chat.view.lastSeq + i + 1,
    at,
  }));
  await fs.mkdir(chat.dir, { recursive: true });
  const lines = added.map((entry) => JSON.stringify(entry) + "\n").join("");
  await appendDurable(
    path.join(chat.dir, "events.jsonl"),
    (chat.endsWithNewline ? "" : "\n") + lines,
  );
  chat.endsWithNewline = true;
  chat.entries.push(...added);
  chat.view = project(chat.entries);
  await writeAtomic(
    path.join(chat.dir, "chat.txt"),
    renderChat(chat.view, timeZone),
  );
  return chat.view;
}

export async function openChatLog(dataDir: string, options: ChatLogOptions) {
  const { chats, damaged } = await loadChats(dataDir, options.log);
  const lock = createMutex();
  const chatFor = (ref: ChatRef) => {
    const key = keyOf(ref);
    const chat = chats.get(key) ?? {
      ref: { connectionId: ref.connectionId, chatId: folderName(ref.chatId) },
      dir: path.join(dataDir, ref.connectionId, folderName(ref.chatId)),
      entries: [],
      view: project([]),
      endsWithNewline: true,
    };
    chats.set(key, chat);
    return chat;
  };
  const withChat = <T>(
    ref: ChatRef,
    fn: (session: ChatSession) => Promise<T>,
  ) =>
    lock(keyOf(ref), () => {
      const chat = chatFor(ref);
      return fn({
        view: () => chat.view,
        append: (bodies) => appendEntries(chat, bodies, options),
      });
    });
  return {
    list: () =>
      [...chats.values()].filter((c) => c.entries.length > 0).map((c) => c.ref),
    load: (ref: ChatRef) =>
      Promise.resolve(chats.get(keyOf(ref))?.view ?? project([])),
    append: (ref: ChatRef, bodies: NewEntry[]) =>
      withChat(ref, (session) => session.append(bodies)),
    withChat,
    damaged: () => [...damaged],
  };
}
