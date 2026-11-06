import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseChat, serializeChat } from "./chat-file.ts";
import type { Entry, NewEntry } from "./entries.ts";

export interface Summary {
  date: Date;
  text: string;
}

const safeName = /^[A-Za-z0-9_.-]+$/;

function checkName(name: string): string {
  if (!safeName.test(name) || name === "." || name === "..")
    throw new Error(`unsafe storage name "${name}"`);
  return name;
}

async function writeAtomic(path: string, content: string | Uint8Array) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, content);
  await rename(temporary, path);
}

function parseSummary(content: string): Summary | undefined {
  const match = /^Summary date: (\S+)\n\n([\s\S]*)$/.exec(content);
  const date = match ? new Date(match[1] ?? "") : undefined;
  if (!match || !date || Number.isNaN(date.getTime()))
    throw new Error("summary.txt has no valid date line");
  return { date, text: match[2]?.trim() ?? "" };
}

export class Chat {
  private writing = Promise.resolve();

  constructor(
    readonly connection: string,
    readonly id: string,
    private readonly dir: string,
    private list: Entry[],
    private latestSummary: Summary | undefined,
  ) {}

  get entries(): readonly Entry[] {
    return this.list;
  }

  get summary(): Summary | undefined {
    return this.latestSummary;
  }

  /** Inserts the entry at its place in sent-time order. */
  add<T extends NewEntry>(entry: T): Promise<T & { id: string }> {
    const stored = { ...entry, id: crypto.randomUUID() } as T & { id: string };
    const index = this.list.findLastIndex((other) => other.at <= entry.at);
    this.list.splice(index + 1, 0, stored);
    return this.persist().then(() => stored);
  }

  update<T extends Entry>(entry: T, patch: Partial<T>): Promise<void> {
    Object.assign(entry, patch);
    if (patch.at !== undefined) {
      this.list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    }
    return this.persist();
  }

  async saveSummary(summary: Summary): Promise<void> {
    const content = `Summary date: ${summary.date.toISOString()}\n\n${summary.text}\n`;
    await writeAtomic(join(this.dir, "summary.txt"), content);
    this.latestSummary = summary;
  }

  async saveAttachment(name: string, data: Uint8Array): Promise<string> {
    const file = `attachments/${name.replaceAll(/[^A-Za-z0-9_.-]/g, "_")}`;
    await mkdir(join(this.dir, "attachments"), { recursive: true });
    await writeAtomic(join(this.dir, file), data);
    return file;
  }

  readAttachment(file: string): Promise<Uint8Array> {
    if (!/^attachments\/[A-Za-z0-9_.-]+$/.test(file) || file.includes(".."))
      throw new Error(`unsafe attachment path "${file}"`);
    return Bun.file(join(this.dir, file)).bytes();
  }

  flush(): Promise<void> {
    return this.writing;
  }

  private persist(): Promise<void> {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await writeAtomic(join(this.dir, "chat.txt"), serializeChat(this.list));
      });
    return this.writing;
  }
}

interface DamagedChat {
  connection: string;
  id: string;
  problem: string;
}

async function loadChat(connection: string, id: string, dir: string) {
  const chatFile = Bun.file(join(dir, "chat.txt"));
  const summaryFile = Bun.file(join(dir, "summary.txt"));
  const entries = (await chatFile.exists())
    ? parseChat(await chatFile.text())
    : [];
  const summary = (await summaryFile.exists())
    ? parseSummary(await summaryFile.text())
    : undefined;
  return new Chat(connection, id, dir, entries, summary);
}

async function directories(path: string): Promise<string[]> {
  const items = await readdir(path, { withFileTypes: true });
  return items
    .filter((item) => item.isDirectory() && safeName.test(item.name))
    .map((item) => item.name);
}

export class ChatStore {
  private constructor(
    private readonly root: string,
    private readonly chats: Map<string, Chat>,
    readonly damaged: DamagedChat[],
  ) {}

  /** Fails when the folder is missing or not writable, so history never moves silently. */
  static async open(root: string): Promise<ChatStore> {
    if (!(await stat(root)).isDirectory())
      throw new Error(`${root} is not a folder`);
    await writeAtomic(join(root, ".write-check"), "ok");
    const chats = new Map<string, Chat>();
    const damaged: DamagedChat[] = [];
    for (const connection of await directories(root)) {
      for (const id of await directories(join(root, connection))) {
        try {
          const chat = await loadChat(
            connection,
            id,
            join(root, connection, id),
          );
          chats.set(`${connection}/${id}`, chat);
        } catch (error) {
          damaged.push({ connection, id, problem: String(error) });
        }
      }
    }
    return new ChatStore(root, chats, damaged);
  }

  all(): Chat[] {
    return [...this.chats.values()];
  }

  chat(connection: string, id: string): Chat {
    const key = `${checkName(connection)}/${checkName(id)}`;
    if (this.damaged.some((d) => d.connection === connection && d.id === id))
      throw new Error(`chat ${key} is damaged and cannot take new records`);
    let chat = this.chats.get(key);
    if (!chat) {
      chat = new Chat(connection, id, join(this.root, key), [], undefined);
      this.chats.set(key, chat);
    }
    return chat;
  }
}
