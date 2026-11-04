import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../log.ts";
import type { EntryBody } from "../record/types.ts";
import { openChatStore } from "./chat-store.ts";

let dataDir = "";
const log = createLogger({}, () => {});
const now = () => new Date("2026-11-04T10:15:00.000Z");
const open = () => openChatStore(dataDir, { timeZone: "UTC", log, now });
const ref = { connectionId: "tg", chatId: "42" };

const customerMessage = (id: string): EntryBody => ({
  type: "message",
  message: {
    id,
    author: { role: "customer" },
    sentAt: "2026-11-04T10:15:00.000Z",
    text: `text ${id}`,
    attachments: [],
    delivery: "observed",
  },
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-store-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

test("appends entries, writes chat.txt and reloads them after a restart", async () => {
  const store = await open();
  const view = await store.append(ref, [
    { ...customerMessage("m1"), eventId: "e1" },
  ]);
  expect(view.lastSeq).toBe(1);
  const lines = (
    await fs.readFile(path.join(dataDir, "tg/42/events.jsonl"), "utf8")
  ).split("\n");
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    ...customerMessage("m1"),
    eventId: "e1",
    seq: 1,
    at: "2026-11-04T10:15:00.000Z",
  });
  expect(await fs.readFile(path.join(dataDir, "tg/42/chat.txt"), "utf8")).toBe(
    "[2026-11-04 10:15:00 UTC] Customer: text m1\n",
  );

  const reopened = await open();
  expect(reopened.list()).toEqual([ref]);
  expect((await reopened.load(ref)).messages.map((m) => m.id)).toEqual(["m1"]);
  expect((await reopened.append(ref, [customerMessage("m2")])).lastSeq).toBe(2);
});

test("isolates a chat with a damaged line and loads the other chats", async () => {
  await fs.mkdir(path.join(dataDir, "tg/bad"), { recursive: true });
  const good = JSON.stringify({
    ...customerMessage("m1"),
    seq: 1,
    at: "2026-11-04T10:00:00Z",
  });
  await fs.writeFile(
    path.join(dataDir, "tg/bad/events.jsonl"),
    `${good}\n{broken`,
  );
  const first = await open();
  await first.append(ref, [customerMessage("m2")]);

  const store = await open();
  expect(store.damaged()).toEqual([
    {
      ref: { connectionId: "tg", chatId: "bad" },
      error: "events.jsonl line 2 is not a valid entry",
    },
  ]);
  expect((await store.load(ref)).messages.map((m) => m.id)).toEqual(["m2"]);
  const bad = { connectionId: "tg", chatId: "bad" };
  expect((await store.load(bad)).messages.map((m) => m.id)).toEqual(["m1"]);
  await store.append(bad, [customerMessage("m3")]);
  const text = await fs.readFile(
    path.join(dataDir, "tg/bad/events.jsonl"),
    "utf8",
  );
  expect(text.split("\n").at(-2)).toContain('"seq":2');
});

test("concurrent appends keep every entry with increasing seq", async () => {
  const store = await open();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.append(ref, [customerMessage(`m${i}`)]),
    ),
  );
  const reopened = await open();
  const view = await reopened.load(ref);
  expect(view.messages.map((m) => m.seq)).toEqual(
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  expect(new Set(view.messages.map((m) => m.id)).size).toBe(20);
});

test("withChat runs a read-modify-append section without interleaving", async () => {
  const store = await open();
  const appendOnce = (id: string) =>
    store.withChat(ref, async (chat) => {
      if (chat.view().messages.length > 0) return;
      await Bun.sleep(5);
      await chat.append([customerMessage(id)]);
    });
  await Promise.all([appendOnce("a"), appendOnce("b")]);
  expect((await store.load(ref)).messages.map((m) => m.id)).toEqual(["a"]);
});

test("stores summaries, text files and attachments in the chat folder", async () => {
  const store = await open();
  expect(await store.readSummary(ref)).toBeUndefined();
  await store.writeSummary(ref, {
    generatedAt: "2026-11-04T10:00:00.000Z",
    text: "Line 1\nLine 2",
  });
  expect(
    await fs.readFile(path.join(dataDir, "tg/42/summary.txt"), "utf8"),
  ).toBe("Generated: 2026-11-04T10:00:00.000Z\n\nLine 1\nLine 2");
  expect(await store.readSummary(ref)).toEqual({
    generatedAt: "2026-11-04T10:00:00.000Z",
    text: "Line 1\nLine 2",
  });

  expect(await store.fileExists(ref, "paused")).toBe(false);
  await store.writeTextFile(ref, "paused", "reason");
  expect(await store.readTextFile(ref, "paused")).toBe("reason");
  await store.removeFile(ref, "paused");
  expect(await store.fileExists(ref, "paused")).toBe(false);
  expect(() => store.fileExists(ref, "../x")).toThrow();

  const relative = await store.saveAttachment(
    ref,
    "m1-a1.jpg",
    new Uint8Array([1, 2]),
  );
  expect(relative).toBe("attachments/m1-a1.jpg");
  expect([...(await fs.readFile(store.attachmentPath(ref, relative)))]).toEqual(
    [1, 2],
  );
  expect(() => store.attachmentPath(ref, "../events.jsonl")).toThrow();
});

test("uses the chat id as folder name and refuses other chat ids", async () => {
  const store = await open();
  await store.append({ connectionId: "tg", chatId: "-100_a-B9" }, [
    customerMessage("m1"),
  ]);
  expect(await fs.readdir(path.join(dataDir, "tg"))).toEqual(["-100_a-B9"]);
  for (const chatId of ["a.b", "a/b", "", "x".repeat(129)]) {
    const bad = { connectionId: "tg", chatId };
    await expect(store.append(bad, [customerMessage("m2")])).rejects.toThrow(
      `Invalid chat id "${chatId}"`,
    );
    expect(() => store.fileExists(bad, "paused")).toThrow(
      `Invalid chat id "${chatId}"`,
    );
  }
});

test("reports a folder whose name is not a chat id and does not load it", async () => {
  await fs.mkdir(path.join(dataDir, "tg/a.b"), { recursive: true });
  const line = JSON.stringify({
    ...customerMessage("m1"),
    seq: 1,
    at: "2026-11-04T10:00:00Z",
  });
  await fs.writeFile(path.join(dataDir, "tg/a.b/events.jsonl"), `${line}\n`);
  const store = await open();
  expect(store.list()).toEqual([]);
  expect(store.damaged()).toEqual([
    {
      ref: { connectionId: "tg", chatId: "a.b" },
      error: "folder name is not a valid chat id, chat not loaded",
    },
  ]);
});

test("refuses a data folder that does not exist", async () => {
  await expect(
    openChatStore(path.join(dataDir, "missing"), { timeZone: "UTC", log }),
  ).rejects.toThrow("Data folder does not exist");
});
