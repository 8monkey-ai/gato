import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isEntryType } from "../record/projection.ts";
import type { ChatRef, Entry } from "../record/types.ts";

export const isChatId = (chatId: string) =>
  /^[A-Za-z0-9_-]{1,128}$/.test(chatId);

export function chatDir(dataDir: string, ref: ChatRef): string {
  if (!isChatId(ref.chatId))
    throw new Error(
      `Invalid chat id "${ref.chatId}": use 1 to 128 letters, digits, "_" or "-"`,
    );
  return path.join(dataDir, ref.connectionId, ref.chatId);
}

export const chatKey = (ref: ChatRef) => `${ref.connectionId}/${ref.chatId}`;

export function plainFileName(name: string): string {
  if (name !== path.basename(name) || name.startsWith(".") || name === "")
    throw new Error(`Not a plain file name: ${name}`);
  return name;
}

export async function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function appendDurable(file: string, text: string) {
  const handle = await fs.open(file, "a");
  try {
    await handle.write(text);
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

export async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseEntry(line: string): Entry | undefined {
  try {
    const value = JSON.parse(line) as Partial<Entry> | null;
    const valid =
      Number.isInteger(value?.seq) &&
      typeof value?.at === "string" &&
      isEntryType(value.type);
    return valid ? (value as Entry) : undefined;
  } catch {
    return undefined;
  }
}

export function parseEntries(text: string) {
  const entries: Entry[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
    else errors.push(`events.jsonl line ${index + 1} is not a valid entry`);
  });
  return {
    entries,
    errors,
    endsWithNewline: text === "" || text.endsWith("\n"),
  };
}

export async function subdirectories(dir: string): Promise<string[]> {
  const items = await fs.readdir(dir, { withFileTypes: true });
  return items
    .filter((item) => item.isDirectory() && !item.name.startsWith("."))
    .map((item) => item.name);
}

export async function assertWritableDir(dir: string) {
  const stat = await fs.stat(dir).catch(() => undefined);
  if (!stat?.isDirectory())
    throw new Error(`Data folder does not exist: ${dir}`);
  const probe = path.join(dir, `.gato-probe-${randomUUID()}`);
  try {
    await fs.writeFile(probe, "");
    await fs.rm(probe);
  } catch (error) {
    throw new Error(`Data folder is not writable: ${dir}`, { cause: error });
  }
}
