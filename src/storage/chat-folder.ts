import { truncate } from "node:fs/promises";
import { join } from "node:path";

import type { z } from "zod";

import { type ChatEvent, chatEvent } from "../conversation/events.ts";
import { type ChatState, chatState } from "../conversation/state.ts";
import type { Logger } from "../log/logger.ts";
import { appendSynced, readIfExists, writeAtomic } from "./files.ts";

/** The files of one chat folder, as found on disk. Events are in record order. */
interface FolderRecord {
  state: ChatState | undefined;
  events: ChatEvent[];
  hasChatTxt: boolean;
}

/** Throws when a file is damaged. Completes or removes a last line of events.jsonl that has no line end. */
export async function readFolder(
  dir: string,
  logger: Logger,
): Promise<FolderRecord> {
  const [events, state, chatTxt] = await Promise.all([
    readEvents(join(dir, "events.jsonl"), logger),
    readState(dir),
    readIfExists(join(dir, "chat.txt")),
  ]);
  return { events, state, hasChatTxt: chatTxt !== undefined };
}

export async function writeState(dir: string, state: ChatState): Promise<void> {
  await writeAtomic(
    join(dir, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function appendEvents(
  dir: string,
  events: readonly ChatEvent[],
): Promise<void> {
  const lines = events.map((event) => `${JSON.stringify(event)}\n`);
  await appendSynced(join(dir, "events.jsonl"), lines.join(""));
}

export async function writeChatTxt(dir: string, text: string): Promise<void> {
  await writeAtomic(join(dir, "chat.txt"), text);
}

export async function readState(dir: string): Promise<ChatState | undefined> {
  const bytes = await readIfExists(join(dir, "state.json"));
  return bytes && parse(chatState, bytes.toString("utf8"), "state.json");
}

async function readEvents(path: string, logger: Logger): Promise<ChatEvent[]> {
  const bytes = await readIfExists(path);
  if (!bytes) return [];
  const end = bytes.lastIndexOf("\n") + 1;
  const lines = bytes.subarray(0, end).toString("utf8").split("\n");
  const events = lines
    .slice(0, -1)
    .map((line, index) => parseEvent(line, index + 1));
  if (end === bytes.length) return events;
  const last = nextEvent(bytes.subarray(end).toString("utf8"), events.length);
  if (last) {
    // The append wrote the whole event; only the line end is missing.
    await appendSynced(path, "\n");
    return [...events, last];
  }
  // Each append writes whole lines, so a last line that is not a whole event is an interrupted write that was never confirmed.
  logger.warn(
    { file: path, bytes: bytes.length - end },
    "removed the incomplete last line of events.jsonl",
  );
  await truncate(path, end);
  return events;
}

function nextEvent(line: string, count: number): ChatEvent | undefined {
  try {
    return parseEvent(line, count + 1);
  } catch {
    return undefined;
  }
}

function parseEvent(line: string, number: number): ChatEvent {
  const event = parse(chatEvent, line, `events.jsonl line ${number}`);
  if (event.seq !== number) {
    throw new Error(`events.jsonl line ${number}: seq must be ${number}`);
  }
  return event;
}

function parse<T extends z.ZodType>(
  schema: T,
  text: string,
  where: string,
): z.output<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${where}: not valid JSON`);
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.join(".") || "value";
  throw new Error(`${where}: ${path}: ${issue?.message}`);
}
