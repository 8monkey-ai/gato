import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { NewEvent } from "../../src/conversation/events.ts";
import { tmpDataDir } from "../support/data-dir.ts";
import {
  chat,
  chatFile,
  chatPath,
  customer,
  minute,
  openTestStore,
  t0,
} from "../support/store.ts";

const agentReply: NewEvent = {
  type: "message",
  at: t0 + minute,
  messageId: "a1",
  role: "agent",
  sender: { known: true },
  parts: [{ kind: "text", text: "Hi Ali, how can I help?" }],
  delivery: "confirmed",
};

const operatorNote: NewEvent = {
  type: "note",
  at: t0 + 2 * minute,
  kind: "comment",
  author: "operator",
  text: "Returning customer",
};

test("saves events, state and a readable chat.txt in the chat folder", async () => {
  const dataDir = await tmpDataDir();
  const store = await openTestStore(dataDir);
  const result = await store.append(chat, [
    customer(0, "Hello", "tg:1"),
    agentReply,
    operatorNote,
  ]);

  expect(result.duplicates).toBe(0);
  expect(result.appended.map((event) => [event.seq, event.recordedAt])).toEqual(
    [
      [1, 1711938600000],
      [2, 1711938600000],
      [3, 1711938600000],
    ],
  );
  expect((await chatFile(dataDir, "events.jsonl")).split("\n")[0]).toBe(
    '{"type":"message","seq":1,"at":1711935000000,"recordedAt":1711938600000,"dedupKey":"tg:1","messageId":"c0","role":"customer","sender":{"id":"u1","name":"Ali","known":true},"parts":[{"kind":"text","text":"Hello"}],"delivery":"received"}',
  );
  expect(JSON.parse(await chatFile(dataDir, "state.json"))).toEqual({
    version: 1,
    appliedSeq: 3,
    chat: { kind: "telegram", connection: "main", chatKey: "42" },
    status: "open",
    statusAt: 0,
    owner: { kind: "agent", at: 0, source: "local" },
    labels: [],
    activity: { lastCustomerAt: 1711935000000, lastAgentAt: 1711935060000 },
  });
  expect(await chatFile(dataDir, "chat.txt")).toBe(
    "[2024-04-01 09:30:00 +08:00] Customer (Ali): Hello\n" +
      "[2024-04-01 09:31:00 +08:00] Agent: Hi Ali, how can I help?\n" +
      "[2024-04-01 09:32:00 +08:00] Internal note (comment, by operator): Returning customer\n",
  );
});

test("keeps all of 50 parallel appends to one chat", async () => {
  const store = await openTestStore(await tmpDataDir());
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      store.append(chat, [customer(i, `m${i}`, `tg:${i}`)]),
    ),
  );
  const { state, events } = await store.read(chat);
  expect(events.map((event) => event.seq).toSorted((a, b) => a - b)).toEqual(
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  expect(state.appliedSeq).toBe(50);
});

test("saves an event with a known dedupKey once and counts the duplicates", async () => {
  const store = await openTestStore(await tmpDataDir());
  await store.append(chat, [customer(0, "Hello", "tg:1")]);
  const again = await store.append(chat, [
    customer(0, "Hello", "tg:1"),
    customer(1, "More", "tg:2"),
    customer(1, "More", "tg:2"),
  ]);
  expect(again.duplicates).toBe(2);
  expect(again.appended.map((event) => event.dedupKey)).toEqual(["tg:2"]);
  expect((await store.read(chat)).events.length).toBe(2);
});

test("an event with a known dedupKey is a duplicate for a new store on the same folder", async () => {
  const dataDir = await tmpDataDir();
  await (
    await openTestStore(dataDir)
  ).append(chat, [customer(0, "Hello", "tg:1")]);
  const again = await (
    await openTestStore(dataDir)
  ).append(chat, [customer(0, "Hello", "tg:1")]);
  expect([again.appended, again.duplicates]).toEqual([[], 1]);
});

test("a manual edit of state.json applies on the next read and stays after an append", async () => {
  const dataDir = await tmpDataDir();
  const store = await openTestStore(dataDir);
  await store.append(chat, [customer(0, "Hello")]);
  const path = chatPath(dataDir, "state.json");
  const edited = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    path,
    JSON.stringify({
      ...edited,
      owner: { kind: "human", at: 0, source: "local" },
      labels: ["vip"],
    }),
  );

  expect((await store.read(chat)).state.owner.kind).toBe("human");
  await store.append(chat, [customer(1, "Still there?")]);
  const { state } = await store.read(chat);
  expect([state.owner.kind, state.labels, state.appliedSeq]).toEqual([
    "human",
    ["vip"],
    2,
  ]);
});

test("a delayed message takes its sent-time place and does not move customer activity back", async () => {
  const dataDir = await tmpDataDir();
  const store = await openTestStore(dataDir);
  await store.append(chat, [customer(5, "Second")]);
  await store.append(chat, [customer(1, "First")]);

  const { state, events } = await store.read(chat);
  expect(events.map((event) => event.seq)).toEqual([2, 1]);
  expect(state.activity.lastCustomerAt).toBe(t0 + 5 * minute);
  expect(await chatFile(dataDir, "chat.txt")).toBe(
    "[2024-04-01 09:31:00 +08:00] Customer (Ali): First\n" +
      "[2024-04-01 09:35:00 +08:00] Customer (Ali): Second\n",
  );
});

test("a deleted chat folder starts a new record", async () => {
  const dataDir = await tmpDataDir();
  const store = await openTestStore(dataDir);
  await store.append(chat, [customer(0, "Hello", "tg:1")]);
  await rm(join(dataDir, "main", "42"), { recursive: true });

  const { appended } = await store.append(chat, [customer(0, "Hello", "tg:1")]);
  expect(appended.map((event) => event.seq)).toEqual([1]);
});

test("rejects names that are not one safe folder name", async () => {
  const store = await openTestStore(await tmpDataDir());
  await expect(store.read({ ...chat, chatKey: ".." })).rejects.toThrow(
    new Error(
      'Chat key ".." cannot be a folder name. Use letters, digits, ".", "_" and "-", not starting with ".".',
    ),
  );
  await expect(
    store.append({ ...chat, connection: "a/b" }, []),
  ).rejects.toThrow(
    new Error(
      'Connection name "a/b" cannot be a folder name. Use letters, digits, ".", "_" and "-", not starting with ".".',
    ),
  );
});
