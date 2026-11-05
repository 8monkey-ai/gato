import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { type ChatState, type Entry, initialState } from "./entry.ts";

export interface Conversation {
  connection: string;
  chat: string;
  dir: string;
  entries: Entry[];
  state: ChatState;
}

export function logFields(conversation: Conversation) {
  return { connection: conversation.connection, chat: conversation.chat };
}

const safeName = /^[A-Za-z0-9_-]+$/;

export function isSafeName(value: string) {
  return safeName.test(value);
}

async function writeAtomic(path: string, data: string | Uint8Array) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, data);
  await rename(temporary, path);
}

function parseEntries(text: string) {
  const entries = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
  return entries.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

async function loadConversation(
  dataDir: string,
  connection: string,
  chat: string,
) {
  const dir = join(dataDir, connection, chat);
  const chatFile = Bun.file(join(dir, "chat.txt"));
  const stateFile = Bun.file(join(dir, "state.json"));
  const entries = (await chatFile.exists())
    ? parseEntries(await chatFile.text())
    : [];
  const state = (await stateFile.exists())
    ? { ...initialState(), ...((await stateFile.json()) as Partial<ChatState>) }
    : initialState();
  return { connection, chat, dir, entries, state } satisfies Conversation;
}

async function directories(path: string) {
  const items = await readdir(path, { withFileTypes: true });
  return items
    .filter((item) => item.isDirectory() && isSafeName(item.name))
    .map((item) => item.name);
}

export async function checkWritable(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const probe = join(dataDir, `.write-check-${crypto.randomUUID()}`);
  await Bun.write(probe, "ok");
  await rm(probe);
}

export async function loadAll(dataDir: string) {
  const loaded: Conversation[] = [];
  const damaged: { connection: string; chat: string; error: string }[] = [];
  for (const connection of await directories(dataDir)) {
    for (const chat of await directories(join(dataDir, connection))) {
      try {
        loaded.push(await loadConversation(dataDir, connection, chat));
      } catch (error) {
        damaged.push({
          connection,
          chat,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { loaded, damaged };
}

export function newConversation(
  dataDir: string,
  connection: string,
  chat: string,
): Conversation {
  return {
    connection,
    chat,
    dir: join(dataDir, connection, chat),
    entries: [],
    state: initialState(),
  };
}

const queues = new WeakMap<Conversation, Promise<unknown>>();

async function write(conversation: Conversation) {
  await mkdir(conversation.dir, { recursive: true });
  const lines = conversation.entries
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await writeAtomic(
    join(conversation.dir, "chat.txt"),
    lines === "" ? "" : `${lines}\n`,
  );
  await writeAtomic(
    join(conversation.dir, "state.json"),
    JSON.stringify(conversation.state, null, 2),
  );
}

export function save(conversation: Conversation) {
  const next = (queues.get(conversation) ?? Promise.resolve()).then(() =>
    write(conversation),
  );
  queues.set(
    conversation,
    next.catch(() => undefined),
  );
  return next;
}

export async function saveFile(
  conversation: Conversation,
  name: string,
  data: Uint8Array,
) {
  const dir = join(conversation.dir, "attachments");
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, name), data);
  return `attachments/${name}`;
}

export async function readFile(
  conversation: Conversation,
  relativePath: string,
) {
  return new Uint8Array(
    await Bun.file(join(conversation.dir, relativePath)).arrayBuffer(),
  );
}

export async function readText(conversation: Conversation, name: string) {
  const file = Bun.file(join(conversation.dir, name));
  return (await file.exists()) ? await file.text() : undefined;
}

export async function writeText(
  conversation: Conversation,
  name: string,
  text: string,
) {
  await mkdir(conversation.dir, { recursive: true });
  await writeAtomic(join(conversation.dir, name), text);
}
