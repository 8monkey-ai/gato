import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { createLogger } from "../log.ts";
import type { ChatMessage, EntryBody } from "../record/types.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { createControls } from "./controls.ts";
import { mergeChats } from "./merge.ts";

const log = createLogger({}, () => {});
const from = { connectionId: "rio", chatId: "old" };
const into = { connectionId: "rio", chatId: "new" };
let dataDir = "";

const message = (
  fields: Partial<ChatMessage> & { id: string; platformId: string },
  minute: number,
): EntryBody => ({
  type: "message",
  message: {
    author: { role: "customer" },
    sentAt: `2026-11-04T10:${String(minute).padStart(2, "0")}:00.000Z`,
    attachments: [],
    delivery: "observed",
    ...fields,
  },
});

async function setup() {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log });
  const file = await store.saveAttachment(
    from,
    "m1-a1.jpg",
    new Uint8Array([1, 2, 3]),
  );
  const preparation = {
    model: "vision",
    at: "2026-11-04T10:01:00.000Z",
    text: "a cat",
  };
  const photo = {
    id: "a1",
    category: "image" as const,
    source: "s1",
    file,
    preparation,
  };
  await store.append(into, [
    message({ id: "m1", platformId: "p-dup", text: "dup" }, 5),
    message({ id: "m2", platformId: "p2", text: "hello" }, 2),
  ]);
  await store.append(from, [
    {
      ...message({ id: "m1", platformId: "p1", attachments: [photo] }, 0),
      eventId: "e1",
    },
    message({ id: "m4", platformId: "p-dup", text: "dup" }, 5),
    message(
      {
        id: "m3",
        platformId: "p3",
        text: "hello",
        author: { role: "agent" },
        delivery: "sent",
      },
      10,
    ),
  ]);
  return store;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-merge-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

test("a merge keeps chronology, copies attachments and skips known platform ids", async () => {
  const store = await setup();
  await mergeChats(store, from, into);
  const view = await store.load(into);
  expect(
    view.messages.map((m) => [m.platformId, m.author.role, m.text]),
  ).toEqual([
    ["p1", "customer", undefined],
    ["p2", "customer", "hello"],
    ["p-dup", "customer", "dup"],
    ["p3", "agent", "hello"],
  ]);
  const [copied] = view.messages;
  expect(copied?.id).not.toBe("m1");
  expect(copied?.eventId).toBeUndefined();
  expect(view.hasPendingInput).toBe(false);
  const attachment = copied?.attachments[0];
  expect(attachment?.file).toBe(`attachments/${copied?.id}-m1-a1.jpg`);
  expect(attachment?.preparation).toEqual({
    model: "vision",
    at: "2026-11-04T10:01:00.000Z",
    text: "a cat",
  });
  const bytes = await fs.readFile(
    store.attachmentPath(into, attachment?.file ?? ""),
  );
  expect([...bytes]).toEqual([1, 2, 3]);
  expect(view.messages[3]?.id).toBe("m3");
  expect(view.merges.map((m) => m.fromChatId)).toEqual(["old"]);
});

test("a merge closes the old chat and refuses a second merge", async () => {
  const store = await setup();
  await mergeChats(store, from, into);
  expect(await store.readTextFile(from, "merged-into")).toBe("new\n");
  const controls = createControls({
    store,
    connection: () => ({}) as ChannelConnection,
    labels: { handoff: "h", outOfScope: "o", error: "e", expired: "x" },
    log,
  });
  expect((await controls.state(from)).open).toBe(false);
  expect((await controls.state(into)).open).toBe(true);
  await expect(mergeChats(store, from, into)).rejects.toThrow(
    "Chat old is already merged",
  );
  await expect(
    mergeChats(store, from, { connectionId: "tg", chatId: "new" }),
  ).rejects.toThrow("Both chats must belong to the same connection");
});
