import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DestinationStream } from "pino";

import type { NewEvent } from "../../src/conversation/events.ts";
import { createLogger } from "../../src/log/logger.ts";
import {
  type FsStoreOptions,
  openFsStore,
} from "../../src/storage/fs-store.ts";

export const chat = { kind: "telegram", connection: "main", chatKey: "42" };

/** 2024-04-01 09:30:00 in Kuala Lumpur. */
export const t0 = Date.UTC(2024, 3, 1, 1, 30);
export const minute = 60_000;

export function chatPath(dataDir: string, name: string): string {
  return join(dataDir, chat.connection, chat.chatKey, name);
}

export function chatFile(dataDir: string, name: string): Promise<string> {
  return readFile(chatPath(dataDir, name), "utf8");
}

export function openTestStore(
  dataDir: string,
  overrides: Partial<FsStoreOptions> = {},
) {
  return openFsStore({
    dataDir,
    timeZone: "Asia/Kuala_Lumpur",
    now: () => t0 + 60 * minute,
    logger: createLogger({ GATO_LOG_LEVEL: "silent" }),
    chatStart: () => ({
      status: "open",
      owner: { kind: "agent", source: "local" },
    }),
    ...overrides,
  });
}

/** A logger that keeps each log record. */
export function capturingLogger() {
  const records: Record<string, unknown>[] = [];
  const destination: DestinationStream = {
    write: (line: string) => {
      records.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { logger: createLogger({}, destination), records };
}

export function customer(
  minutes: number,
  text: string,
  dedupKey?: string,
): NewEvent {
  return {
    type: "message",
    at: t0 + minutes * minute,
    dedupKey,
    messageId: `c${minutes}`,
    role: "customer",
    sender: { id: "u1", name: "Ali", known: true },
    parts: [{ kind: "text", text }],
    delivery: "received",
  };
}
