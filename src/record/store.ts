import { mkdir, opendir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.ts";
import {
  type Attachment,
  type Entry,
  type MessageEntry,
  parseChat,
  serializeChat,
} from "./chat-file.ts";

export type Summary = { at: string; text: string };

export type Chat = { entries: readonly Entry[]; damaged: boolean };

type Edit = Chat & {
  add(entry: Entry): void;
  remove(entry: Entry): void;
  save(): Promise<void>;
};

type Shared = { locks: Map<string, Promise<unknown>>; damaged: Set<string> };

const safeId = /^[A-Za-z0-9_-]{1,128}$/;

export class Conversation {
  constructor(
    readonly connection: string,
    readonly contact: string,
    private readonly dir: string,
    private readonly shared: Shared,
  ) {}

  get id() {
    return `${this.connection}/${this.contact}`;
  }

  lock<T>(work: (edit: Edit) => T | Promise<T>): Promise<T> {
    const { locks } = this.shared;
    const result = (locks.get(this.id) ?? Promise.resolve()).then(async () =>
      work(await this.#open()),
    );
    const tail = result.catch(() => undefined);
    locks.set(this.id, tail);
    void tail.then(() => {
      if (locks.get(this.id) === tail) locks.delete(this.id);
    });
    return result;
  }

  read(): Promise<Chat> {
    return this.lock(({ entries, damaged }) => ({ entries, damaged }));
  }

  updateAttachment(
    message: MessageEntry,
    attachment: Attachment,
    fields: Partial<Attachment>,
  ) {
    const index = message.attachments?.indexOf(attachment) ?? -1;
    return this.lock(async (edit) => {
      const stored = edit.entries.find(
        (e) =>
          e.kind === "message" &&
          e.at === message.at &&
          e.role === message.role &&
          e.ref === message.ref,
      );
      const target =
        stored?.kind === "message" ? stored.attachments?.[index] : undefined;
      if (!target) return;
      Object.assign(target, fields);
      await edit.save();
    });
  }

  async #open(): Promise<Edit> {
    const file = Bun.file(join(this.dir, "chat.txt"));
    const parsed = (await file.exists())
      ? parseChat(await file.text())
      : { entries: [], damaged: 0 };
    this.#report(parsed.damaged);
    const entries = parsed.entries.sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
    );
    const save = async () => {
      await mkdir(join(this.dir, "attachments"), { recursive: true });
      await writeAtomic(join(this.dir, "chat.txt"), serializeChat(entries));
    };
    if (markInterruptedSends(entries, this.id)) await save();
    return {
      entries,
      damaged: parsed.damaged > 0,
      add: (entry) => {
        let index = entries.length;
        while (index > 0 && (entries[index - 1]?.at ?? "") > entry.at) index--;
        entries.splice(index, 0, entry);
      },
      remove: (entry) => {
        entries.splice(entries.indexOf(entry), 1);
      },
      save,
    };
  }

  #report(damaged: number) {
    const known = this.shared.damaged;
    if (!damaged) {
      known.delete(this.id);
    } else if (!known.has(this.id)) {
      known.add(this.id);
      log.error("record.damaged", { conversation: this.id, entries: damaged });
    }
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

  async readSummary(): Promise<Summary | undefined> {
    const file = Bun.file(join(this.dir, "summary.txt"));
    return (await file.exists()) ? parseSummary(await file.text()) : undefined;
  }

  async saveSummary(summary: Summary) {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(
      join(this.dir, "summary.txt"),
      `Summarized at: ${summary.at}\n\n${summary.text}\n`,
    );
  }
}

export class ConversationStore {
  readonly #shared: Shared = { locks: new Map(), damaged: new Set() };

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<ConversationStore> {
    if (!(await stat(root)).isDirectory())
      throw new Error(`${root} is not a folder`);
    const probe = join(root, ".write-check");
    await Bun.write(probe, "ok");
    await unlink(probe);
    return new ConversationStore(root);
  }

  get(connection: string, contact: string): Conversation {
    if (!safeId.test(connection) || !safeId.test(contact)) {
      throw new Error(
        `Unsafe conversation identifier: ${connection}/${contact}`,
      );
    }
    return new Conversation(
      connection,
      contact,
      join(this.root, connection, contact),
      this.#shared,
    );
  }

  get damagedCount() {
    return this.#shared.damaged.size;
  }

  // Every write renews chat.txt, so its modification time is never earlier than the latest entry.
  async changedSince(connection: string, time: number) {
    const dir = join(this.root, connection);
    const changed: Conversation[] = [];
    for await (const item of await opendir(dir).catch(() => [])) {
      if (!item.isDirectory() || !safeId.test(item.name)) continue;
      const modified = await stat(join(dir, item.name, "chat.txt")).then(
        (s) => s.mtimeMs,
        () => 0,
      );
      if (modified >= time) changed.push(this.get(connection, item.name));
    }
    return changed;
  }
}

// Only a stopped process or a failed write leaves "sending" on disk, because a send holds the lock.
function markInterruptedSends(entries: Entry[], conversation: string) {
  const interrupted = entries.filter(
    (e): e is MessageEntry => e.kind === "message" && e.delivery === "sending",
  );
  for (const entry of interrupted) {
    entry.delivery = "uncertain";
    log.warn("delivery.uncertain_after_restart", {
      conversation,
      at: entry.at,
    });
  }
  return interrupted.length > 0;
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
