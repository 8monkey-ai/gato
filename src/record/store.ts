import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.ts";
import { type Entry, parseChat, serializeChat } from "./chat-file.ts";

export type Summary = { at: string; text: string };

type Edit = {
  add(entry: Entry): void;
  remove(entry: Entry): void;
  save(): Promise<void>;
};

const safeId = /^[A-Za-z0-9_-]{1,128}$/;

export class Conversation {
  #entries: Entry[];
  #queue: Promise<unknown> = Promise.resolve();
  summary: Summary | undefined;
  readonly damaged: number;

  constructor(
    readonly connection: string,
    readonly contact: string,
    private readonly dir: string,
    loaded: { entries: Entry[]; damaged: number; summary?: Summary } = {
      entries: [],
      damaged: 0,
    },
  ) {
    this.#entries = loaded.entries;
    this.summary = loaded.summary;
    this.damaged = loaded.damaged;
  }

  get entries(): readonly Entry[] {
    return this.#entries;
  }

  lock<T>(work: (edit: Edit) => Promise<T>): Promise<T> {
    const edit: Edit = {
      add: (entry) => this.#insert(entry),
      remove: (entry) => {
        this.#entries = this.#entries.filter((e) => e !== entry);
      },
      save: () => this.#save(),
    };
    const result = this.#queue.then(() => work(edit));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #insert(entry: Entry) {
    let index = this.#entries.length;
    while (index > 0 && (this.#entries[index - 1]?.at ?? "") > entry.at)
      index--;
    this.#entries.splice(index, 0, entry);
  }

  async #save() {
    await mkdir(join(this.dir, "attachments"), { recursive: true });
    await writeAtomic(join(this.dir, "chat.txt"), serializeChat(this.#entries));
  }

  async writeAttachment(bytes: Uint8Array, name: string): Promise<string> {
    const file = `attachments/${crypto.randomUUID().slice(0, 8)}-${safeFileName(name)}`;
    await mkdir(join(this.dir, "attachments"), { recursive: true });
    await Bun.write(join(this.dir, file), bytes);
    return file;
  }

  readAttachment(file: string): Promise<Uint8Array> {
    if (!/^attachments\/(?!\.\.?$)[^/\\]+$/.test(file)) {
      throw new Error(`Attachment path is outside the chat folder: ${file}`);
    }
    return Bun.file(join(this.dir, file)).bytes();
  }

  async saveSummary(summary: Summary) {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(
      join(this.dir, "summary.txt"),
      `Summarized at: ${summary.at}\n\n${summary.text}\n`,
    );
    this.summary = summary;
  }
}

export class ConversationStore {
  private constructor(
    private readonly root: string,
    private readonly conversations: Map<string, Conversation>,
  ) {}

  static async open(root: string): Promise<ConversationStore> {
    if (!(await stat(root)).isDirectory())
      throw new Error(`${root} is not a folder`);
    const probe = join(root, ".write-check");
    await Bun.write(probe, "ok");
    await unlink(probe);
    const conversations = new Map<string, Conversation>();
    for (const connection of await subdirectories(root)) {
      for (const contact of await subdirectories(join(root, connection))) {
        const dir = join(root, connection, contact);
        const loaded = await loadFolder(dir);
        conversations.set(
          key(connection, contact),
          new Conversation(connection, contact, dir, loaded),
        );
      }
    }
    return new ConversationStore(root, conversations);
  }

  get(connection: string, contact: string): Conversation {
    if (!safeId.test(connection) || !safeId.test(contact)) {
      throw new Error(
        `Unsafe conversation identifier: ${connection}/${contact}`,
      );
    }
    const id = key(connection, contact);
    let conversation = this.conversations.get(id);
    if (!conversation) {
      conversation = new Conversation(
        connection,
        contact,
        join(this.root, connection, contact),
      );
      this.conversations.set(id, conversation);
    }
    return conversation;
  }

  list(): Conversation[] {
    return [...this.conversations.values()];
  }
}

const key = (connection: string, contact: string) => `${connection}/${contact}`;

async function subdirectories(dir: string): Promise<string[]> {
  const items = await readdir(dir, { withFileTypes: true });
  return items
    .filter((item) => item.isDirectory() && safeId.test(item.name))
    .map((i) => i.name);
}

async function loadFolder(dir: string) {
  const chat = Bun.file(join(dir, "chat.txt"));
  const parsed = (await chat.exists())
    ? parseChat(await chat.text())
    : { entries: [], damaged: 0 };
  parsed.entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const entry of parsed.entries) {
    // A send that was on its way when the previous process stopped may or may not have arrived.
    if (entry.kind === "message" && entry.delivery === "sending") {
      entry.delivery = "uncertain";
      log.warn("delivery.uncertain_after_restart", {
        folder: dir,
        at: entry.at,
      });
    }
  }
  const summaryFile = Bun.file(join(dir, "summary.txt"));
  const summary = (await summaryFile.exists())
    ? parseSummary(await summaryFile.text())
    : undefined;
  return { ...parsed, summary };
}

function parseSummary(content: string): Summary | undefined {
  const match = /^Summarized at: (\S+)\n\n([\s\S]*?)\n?$/.exec(content);
  const at = match?.[1] && new Date(match[1]);
  return at && !Number.isNaN(at.getTime())
    ? { at: at.toISOString(), text: match[2] ?? "" }
    : undefined;
}

async function writeAtomic(path: string, content: string) {
  const temporary = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await Bun.write(temporary, content);
  await rename(temporary, path);
}

function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  return (
    base
      .replace(/[^\w.-]+/g, "_")
      .replace(/^\.+/, "")
      .slice(-80) || "file"
  );
}
