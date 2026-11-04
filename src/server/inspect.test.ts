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

test("the chat overview counts agent parts and shows no message text", async () => {
  const store = await openChatStore(dataDir, {
    timeZone: "UTC",
    log,
    now: () => new Date("2026-11-04T10:01:00.000Z"),
  });
  await store.append({ connectionId: "tg", chatId: "42" }, entries);
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
      owner: "agent",
      open: true,
      pendingInput: true,
      damaged: false,
      latestTurn: {
        trigger: "customer",
        startedAt: "2026-11-04T10:01:00.000Z",
        outcome: "running",
      },
      agentParts: { failed: 1, pending: 0, uncertain: 0 },
    },
  ]);
});
