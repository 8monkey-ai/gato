import { expect, test } from "bun:test";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";

import type { ChatState } from "../../src/conversation/state.ts";
import { tmpDataDir } from "../support/data-dir.ts";
import {
  capturingLogger,
  chat,
  chatFile,
  chatPath,
  customer,
  openTestStore,
  t0,
} from "../support/store.ts";

/** A data directory with one saved chat: "Hello" at seq 1. */
async function savedChat(): Promise<string> {
  const dataDir = await tmpDataDir();
  await (await openTestStore(dataDir)).append(chat, [customer(0, "Hello")]);
  return dataDir;
}

function appendLine(dataDir: string, line: string): Promise<void> {
  return appendFile(chatPath(dataDir, "events.jsonl"), line);
}

function storedCustomer(seq: number, minutes: number, text: string): string {
  return JSON.stringify({ ...customer(minutes, text), seq, recordedAt: t0 });
}

async function damaged(dataDir: string) {
  return (await openTestStore(dataDir)).health().damaged;
}

test("an incomplete last line of events.jsonl is reported and removed", async () => {
  const dataDir = await savedChat();
  await appendLine(dataDir, '{"type":"mess');

  const { logger, records } = capturingLogger();
  const store = await openTestStore(dataDir, { logger });
  const warning = records.find(
    (record) =>
      record.msg === "removed the incomplete last line of events.jsonl",
  );
  expect(warning).toMatchObject({ level: 40, bytes: 13 });
  const { appended } = await store.append(chat, [customer(1, "Again")]);
  expect(appended.map((event) => event.seq)).toEqual([2]);
  expect((await store.read(chat)).events.length).toBe(2);
  expect(store.health()).toEqual({ damaged: [] });
});

test("a last line without a line end is kept when it is the next event", async () => {
  const dataDir = await savedChat();
  const line = storedCustomer(2, 1, "Kept");
  await appendLine(dataDir, line);

  const store = await openTestStore(dataDir);
  expect((await chatFile(dataDir, "events.jsonl")).endsWith(`${line}\n`)).toBe(
    true,
  );
  const { appended } = await store.append(chat, [customer(2, "Next")]);
  expect(appended.map((event) => event.seq)).toEqual([3]);
  expect((await store.read(chat)).events.map((event) => event.seq)).toEqual([
    1, 2, 3,
  ]);
});

test("a last line without a line end is removed when its seq is not the next one", async () => {
  const dataDir = await savedChat();
  await appendLine(dataDir, storedCustomer(3, 1, "Wrong seq"));

  const store = await openTestStore(dataDir);
  expect((await store.read(chat)).events.length).toBe(1);
  expect(store.health()).toEqual({ damaged: [] });
});

test("a damaged chat is reported while other chats continue", async () => {
  const dataDir = await tmpDataDir();
  const other = { ...chat, chatKey: "43" };
  const first = await openTestStore(dataDir);
  await first.append(chat, [customer(0, "Hello")]);
  await first.append(other, [customer(0, "Hi")]);
  await writeFile(chatPath(dataDir, "state.json"), "{ not json");

  const store = await openTestStore(dataDir);
  const chats = [];
  for await (const ref of store.chats()) chats.push(ref);
  expect(chats).toEqual([other]);
  expect(store.health()).toEqual({
    damaged: [{ chat: "main/42", reason: "state.json: not valid JSON" }],
  });
  await expect(store.read(chat)).rejects.toThrow(
    new Error("Chat main/42 is damaged: state.json: not valid JSON"),
  );
  expect(
    (await store.append(other, [customer(1, "Bye")])).appended.length,
  ).toBe(1);
});

test("a missing state.json with saved events marks the chat damaged", async () => {
  const dataDir = await savedChat();
  await rm(chatPath(dataDir, "state.json"));
  expect(await damaged(dataDir)).toEqual([
    { chat: "main/42", reason: "state.json is missing" },
  ]);
});

test("a gap in seq marks the chat damaged", async () => {
  const dataDir = await savedChat();
  await appendLine(dataDir, `${storedCustomer(3, 1, "Gap")}\n`);
  expect(await damaged(dataDir)).toEqual([
    { chat: "main/42", reason: "events.jsonl line 2: seq must be 2" },
  ]);
});

test("an appliedSeq after the last event marks the chat damaged", async () => {
  const dataDir = await savedChat();
  const path = chatPath(dataDir, "state.json");
  const state = JSON.parse(await readFile(path, "utf8")) as ChatState;
  await writeFile(path, JSON.stringify({ ...state, appliedSeq: 5 }));
  expect(await damaged(dataDir)).toEqual([
    {
      chat: "main/42",
      reason: "state.json appliedSeq 5 is after the last event 1",
    },
  ]);
});

test("applies events that a crash left out of state.json and chat.txt when it opens", async () => {
  const dataDir = await savedChat();
  const owner = {
    type: "owner",
    seq: 2,
    at: t0,
    recordedAt: t0,
    owner: "human",
    source: "channel",
  };
  await appendLine(
    dataDir,
    `${JSON.stringify(owner)}\n${storedCustomer(3, 1, "Are you there?")}\n`,
  );

  await openTestStore(dataDir);
  const state = JSON.parse(await chatFile(dataDir, "state.json")) as ChatState;
  expect([state.appliedSeq, state.owner]).toEqual([
    3,
    { kind: "human", at: t0, source: "channel" },
  ]);
  expect(await chatFile(dataDir, "chat.txt")).toBe(
    "[2024-04-01 09:30:00 +08:00] Customer (Ali): Hello\n" +
      "[2024-04-01 09:31:00 +08:00] Customer (Ali): Are you there?\n",
  );
});

test("writes a missing chat.txt again when it opens", async () => {
  const dataDir = await savedChat();
  await rm(chatPath(dataDir, "chat.txt"));

  await openTestStore(dataDir);
  expect(await chatFile(dataDir, "chat.txt")).toBe(
    "[2024-04-01 09:30:00 +08:00] Customer (Ali): Hello\n",
  );
});
