import fs from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../log.ts";
import { type ChatView, project } from "../record/projection.ts";
import { renderChat } from "../record/render.ts";
import type { ChatRef, Entry, EntryBody } from "../record/types.ts";
import {
  appendDurable,
  chatDir,
  chatKey,
  isChatId,
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

type Damage = { ref: ChatRef; errors: string[] };

function damageRegister(log: Logger) {
  const damaged = new Map<string, Damage>();
  return {
    report: (ref: ChatRef, error: string) => {
      const known = damaged.get(chatKey(ref));
      if (known?.errors.includes(error)) return;
      if (known) known.errors.push(error);
      else damaged.set(chatKey(ref), { ref, errors: [error] });
      log.error("chat.damaged", { ...ref, error });
    },
    isDamaged: (ref: ChatRef) => damaged.has(chatKey(ref)),
    damaged: () => [...damaged.values()],
  };
}
type Report = ReturnType<typeof damageRegister>["report"];

function readChat(chat: Chat, text: string, report: Report) {
  const { entries, errors, endsWithNewline } = parseEntries(text);
  for (const error of errors) report(chat.ref, error);
  chat.entries = entries;
  chat.view = project(entries);
  chat.endsWithNewline = endsWithNewline;
}

async function loadChats(dataDir: string, report: Report) {
  const chats = new Map<string, Chat>();
  for (const connectionId of await subdirectories(dataDir)) {
    for (const chatId of await subdirectories(
      path.join(dataDir, connectionId),
    )) {
      const dir = path.join(dataDir, connectionId, chatId);
      const text = await readOptional(path.join(dir, "events.jsonl"));
      if (text === undefined) continue;
      const ref = { connectionId, chatId };
      if (!isChatId(chatId)) {
        report(ref, "folder name is not a valid chat id, chat not loaded");
        continue;
      }
      const chat = { ref, dir, ...emptyChat() };
      readChat(chat, text, report);
      chats.set(chatKey(ref), chat);
    }
  }
  return chats;
}

const emptyChat = () => ({
  entries: [] as Entry[],
  view: project([]),
  endsWithNewline: true,
});

function createMutex() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

// After a failed write the file may hold a torn line or some of the entries. The file is the
// source of truth, so the chat state is read again: seq numbers on disk are not used twice.
async function recoverFromFailedWrite(chat: Chat, report: Report) {
  const file = path.join(chat.dir, "events.jsonl");
  try {
    readChat(chat, (await readOptional(file)) ?? "", report);
  } catch {
    // The state on disk is unknown, so the chat takes no new agent work.
    report(chat.ref, "events.jsonl could not be read after a failed write");
  }
}

async function writeEntries(chat: Chat, added: Entry[], report: Report) {
  const lines = added.map((entry) => JSON.stringify(entry) + "\n").join("");
  const text = (chat.endsWithNewline ? "" : "\n") + lines;
  chat.endsWithNewline = false;
  try {
    await fs.mkdir(chat.dir, { recursive: true });
    await appendDurable(path.join(chat.dir, "events.jsonl"), text);
  } catch (error) {
    await recoverFromFailedWrite(chat, report);
    throw error;
  }
  chat.endsWithNewline = true;
}

async function appendEntries(
  chat: Chat,
  bodies: NewEntry[],
  { timeZone, now = () => new Date() }: ChatLogOptions,
  report: Report,
) {
  if (bodies.length === 0) return chat.view;
  const at = now().toISOString();
  const added = bodies.map((body, i): Entry => ({
    ...body,
    seq: chat.view.lastSeq + i + 1,
    at,
  }));
  await writeEntries(chat, added, report);
  chat.entries.push(...added);
  chat.view = project(chat.entries);
  await writeAtomic(
    path.join(chat.dir, "chat.txt"),
    renderChat(chat.view, timeZone),
  );
  return chat.view;
}

export async function openChatLog(dataDir: string, options: ChatLogOptions) {
  const damage = damageRegister(options.log);
  const chats = await loadChats(dataDir, damage.report);
  const lock = createMutex();
  const chatFor = (ref: ChatRef) => {
    const key = chatKey(ref);
    const chat = chats.get(key) ?? {
      ref: { connectionId: ref.connectionId, chatId: ref.chatId },
      dir: chatDir(dataDir, ref),
      ...emptyChat(),
    };
    chats.set(key, chat);
    return chat;
  };
  const withChat = <T>(
    ref: ChatRef,
    fn: (session: ChatSession) => Promise<T>,
  ) =>
    lock(chatKey(ref), () => {
      const chat = chatFor(ref);
      return fn({
        view: () => chat.view,
        append: (bodies) => appendEntries(chat, bodies, options, damage.report),
      });
    });
  return {
    list: () =>
      [...chats.values()].filter((c) => c.entries.length > 0).map((c) => c.ref),
    load: (ref: ChatRef) =>
      Promise.resolve(chats.get(chatKey(ref))?.view ?? project([])),
    append: (ref: ChatRef, bodies: NewEntry[]) =>
      withChat(ref, (session) => session.append(bodies)),
    withChat,
    isDamaged: damage.isDamaged,
    damaged: damage.damaged,
  };
}
