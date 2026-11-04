import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { createLogger } from "../log.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { createControls } from "./controls.ts";

let dataDir = "";
let logLines: { level: string; event: string }[] = [];
const ref = { connectionId: "tg", chatId: "42" };
const labels = {
  handoff: "handoff",
  outOfScope: "out-of-scope",
  error: "error",
  expired: "expired",
};

function connection(extra: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: "tg",
    maxTextLength: 4096,
    supportsVideo: false,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: () => Promise.resolve({ status: "sent", sentAt: new Date() }),
    fetchAttachment: () => Promise.reject(new Error("no file")),
    ...extra,
  };
}

async function setup(channel: ChannelConnection) {
  const log = createLogger({}, (line) => {
    logLines.push(JSON.parse(line) as { level: string; event: string });
  });
  const now = () => new Date("2026-11-04T10:15:00.000Z");
  const store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  return {
    store,
    controls: createControls({ store, connection: () => channel, labels, log }),
  };
}

const chatFile = (name: string) => path.join(dataDir, "tg/42", name);

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-controls-"));
  logLines = [];
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

test("the paused and closed files set the local state", async () => {
  const { controls } = await setup(connection());
  expect((await controls.state(ref)).owner).toBe("agent");
  await fs.mkdir(chatFile(""), { recursive: true });
  await fs.writeFile(chatFile("paused"), "busy\n");
  await fs.writeFile(chatFile("closed"), "");
  expect(await controls.state(ref)).toMatchObject({
    owner: "human",
    open: false,
  });
  await fs.rm(chatFile("paused"));
  expect((await controls.state(ref)).owner).toBe("agent");
});

test("local labels append only labels not yet in labels.txt", async () => {
  const { controls } = await setup(connection());
  await fs.mkdir(chatFile(""), { recursive: true });
  await fs.writeFile(chatFile("labels.txt"), "vip");
  await controls.addLabels(ref, ["vip", "handoff", "handoff"]);
  expect(await fs.readFile(chatFile("labels.txt"), "utf8")).toBe(
    "vip\nhandoff\n",
  );
  expect(await controls.readLabels(ref)).toEqual(["vip", "handoff"]);
  expect(await fs.readFile(chatFile("events.jsonl"), "utf8")).toContain(
    '"labels":["vip","handoff","handoff"]',
  );
});

test("a note goes to the notes port and a port failure is only logged", async () => {
  const sent: string[] = [];
  const { store, controls } = await setup(
    connection({
      notes: { add: (_chatId, text) => Promise.resolve(void sent.push(text)) },
      labels: {
        add: () => Promise.reject(new Error("down")),
        read: () => Promise.resolve(["remote"]),
      },
    }),
  );
  await controls.note(ref, { by: "system", kind: "info", text: "Checked" });
  await controls.addLabels(ref, ["vip"]);
  expect(sent).toEqual(["Checked"]);
  expect(await controls.readLabels(ref)).toEqual(["remote"]);
  expect((await store.load(ref)).notes.map((n) => n.text)).toEqual(["Checked"]);
  expect(logLines.map((l) => l.event)).toEqual(["labels.add_failed"]);
});

test("a handoff without native assignment pauses the chat and notifies operators", async () => {
  const notified: string[] = [];
  const { store, controls } = await setup(
    connection({
      notifyOperators: (chatId, text) =>
        Promise.resolve(void notified.push(`${chatId}: ${text}`)),
    }),
  );
  await controls.handoff(ref, {
    path: "error",
    reason: "Model failed",
    turnId: "t1",
  });
  expect(await fs.readFile(chatFile("paused"), "utf8")).toBe("Model failed\n");
  expect(await fs.readFile(chatFile("labels.txt"), "utf8")).toBe(
    "handoff\nerror\n",
  );
  expect(notified).toEqual([
    "42: Operator attention needed (error handoff): Model failed",
  ]);
  const view = await store.load(ref);
  expect(view.handoffs.map((h) => [h.path, h.reason])).toEqual([
    ["error", "Model failed"],
  ]);
  expect(view.notes.map((n) => [n.by, n.kind, n.text])).toEqual([
    ["system", "handoff", "Model failed"],
  ]);
  expect((await controls.state(ref)).owner).toBe("human");
  expect(logLines.map((l) => [l.level, l.event])).toEqual([
    ["warn", "handoff.operator_attention_needed"],
  ]);
});

test("a handoff with native assignment does not pause, and a failed notification is logged", async () => {
  const { controls } = await setup(
    connection({
      assignment: {
        fetchState: () => Promise.resolve({ owner: "agent", open: true }),
      },
      notifyOperators: () => Promise.reject(new Error("down")),
    }),
  );
  await controls.handoff(ref, { path: "tool", reason: "Refund request" });
  expect(await fs.readFile(chatFile("labels.txt"), "utf8")).toBe(
    "handoff\nout-of-scope\n",
  );
  expect(
    await fs.access(chatFile("paused")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(logLines.map((l) => l.event)).toEqual([
    "handoff.tool_failed",
    "handoff.operator_attention_needed",
  ]);
});
