import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { createControls } from "../conversation/controls.ts";
import { createLogger } from "../log.ts";
import { type NewEntry, openChatStore } from "../storage/chat-store.ts";
import { inspectChats } from "./inspect.ts";

const log = createLogger({}, () => {});
let dataDir = "";

const sentAt = "2026-11-04T10:00:00.000Z";
const entries: NewEntry[] = [
  {
    type: "message",
    eventId: "e1",
    message: {
      id: "m1",
      author: { role: "customer" },
      sentAt,
      text: "private words",
      attachments: [],
      delivery: "observed",
    },
  },
  {
    type: "turn-start",
    turnId: "t1",
    trigger: "customer",
    inputThroughSeq: 1,
    instructionsRevision: "r",
  },
  {
    type: "message",
    message: {
      id: "m2",
      author: { role: "agent" },
      sentAt,
      text: "reply words",
      attachments: [],
      delivery: "failed",
    },
  },
];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-inspect-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

const note = (kind: "nudge" | "nudge-failed" | "expiry"): NewEntry => ({
  type: "note",
  by: "system",
  kind,
  text: "private words",
});

test("the chat overview shows states and times and no message text", async () => {
  let clock = new Date("2026-11-04T10:01:00.000Z");
  const store = await openChatStore(dataDir, {
    timeZone: "UTC",
    log,
    now: () => clock,
  });
  const ref = { connectionId: "tg", chatId: "42" };
  await store.append(ref, entries);
  for (const [minute, kind] of [
    ["02", "nudge"],
    ["03", "nudge-failed"],
    ["04", "nudge"],
    ["05", "expiry"],
  ] as const) {
    clock = new Date(`2026-11-04T10:${minute}:00.000Z`);
    await store.append(ref, [note(kind)]);
  }
  await store.writeTextFile(ref, "paused", "Ana handles this\n");
  const controls = createControls({
    store,
    connection: () => ({}) as ChannelConnection,
    labels: { handoff: "h", outOfScope: "o", error: "e", expired: "x" },
    log,
  });
  const chats = await inspectChats({ store, controls });
  expect(JSON.stringify(chats)).not.toContain("words");
  expect(chats).toEqual([
    {
      connectionId: "tg",
      chatId: "42",
      owner: "human",
      open: true,
      paused: true,
      pendingInput: true,
      damaged: false,
      latestCustomerAt: "2026-11-04T10:00:00.000Z",
      lastNudgeAt: "2026-11-04T10:04:00.000Z",
      lastNudgeFailedAt: "2026-11-04T10:03:00.000Z",
      expiredAt: "2026-11-04T10:05:00.000Z",
      latestTurn: {
        trigger: "customer",
        startedAt: "2026-11-04T10:01:00.000Z",
        outcome: "running",
      },
      agentParts: { failed: 1, pending: 0, uncertain: 0 },
    },
  ]);
});

test("an expiry before the latest customer message is not shown", async () => {
  let clock = new Date("2026-11-04T09:00:00.000Z");
  const store = await openChatStore(dataDir, {
    timeZone: "UTC",
    log,
    now: () => clock,
  });
  const ref = { connectionId: "tg", chatId: "42" };
  await store.append(ref, [note("expiry")]);
  clock = new Date("2026-11-04T10:01:00.000Z");
  await store.append(ref, entries);
  const controls = createControls({
    store,
    connection: () => ({}) as ChannelConnection,
    labels: { handoff: "h", outOfScope: "o", error: "e", expired: "x" },
    log,
  });
  const [chat] = await inspectChats({ store, controls });
  expect(chat?.expiredAt).toBeUndefined();
});
