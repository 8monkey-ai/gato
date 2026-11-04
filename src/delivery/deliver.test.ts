import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OutboundPart, SendOutcome } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import { createLogger } from "../log.ts";
import { type ChatStore, openChatStore } from "../storage/chat-store.ts";
import { createDelivery } from "./deliver.ts";

const ref = { connectionId: "tg", chatId: "42" };
const sentAt = new Date("2026-11-04T10:16:00.000Z");
const now = () => new Date("2026-11-04T10:15:00.000Z");
let dataDir = "";
let store: ChatStore;
let logLines: string[] = [];
const log = createLogger({}, (line) => logLines.push(line));

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-deliver-"));
  store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  logLines = [];
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

const delivery = (
  overrides: Partial<Settings["delivery"]> = {},
): Settings["delivery"] => ({
  boundary: "paragraph",
  timing: "stream",
  pacing: "fixed",
  pauseMs: 750,
  perWordMs: 1000,
  stripFinalStop: true,
  video: { linkPrefixes: [], mode: "attachment", surroundingText: "replace" },
  ...overrides,
});

function fakeConnection(outcomes: SendOutcome[] = []) {
  const sent: OutboundPart[] = [];
  const typing: string[] = [];
  const stateAtSend: (string | undefined)[] = [];
  const connection = {
    maxTextLength: 4096,
    supportsVideo: true,
    send: async (_chatId: string, part: OutboundPart) => {
      sent.push(part);
      const { messages } = await store.load(ref);
      stateAtSend.push(
        messages.toSorted((a, b) => a.seq - b.seq).at(-1)?.delivery,
      );
      return (
        outcomes.shift() ?? {
          status: "sent",
          platformId: `p${sent.length}`,
          sentAt,
        }
      );
    },
    typing: (chatId: string) => {
      typing.push(chatId);
      return Promise.resolve();
    },
  };
  return { connection, sent, typing, stateAtSend };
}

function fakeSleep({ manual = false } = {}) {
  const requested: number[] = [];
  const releases: (() => void)[] = [];
  const watchers: { count: number; resolve: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      requested.push(ms);
      for (const w of watchers) if (requested.length >= w.count) w.resolve();
      if (!manual) return resolve();
      releases.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  const requestedCount = (count: number) =>
    new Promise<void>((resolve) => {
      if (requested.length >= count) resolve();
      else watchers.push({ count, resolve });
    });
  const releaseNext = () => releases.shift()?.();
  return { sleep, requested, requestedCount, releaseNext };
}

const records = async (): Promise<object[]> =>
  (await store.load(ref)).messages
    .toSorted((a, b) => a.seq - b.seq)
    .map(({ text, delivery, error, platformId }) => ({
      text,
      delivery,
      error,
      platformId,
    }));

function start(
  connection: ReturnType<typeof fakeConnection>["connection"],
  options: {
    settings?: Settings["delivery"];
    sleep?: ReturnType<typeof fakeSleep>["sleep"];
    signal?: AbortSignal;
    store?: Pick<ChatStore, "append">;
  } = {},
) {
  return createDelivery({
    store: options.store ?? store,
    settings: options.settings ?? delivery(),
    log,
    sleep: options.sleep ?? fakeSleep().sleep,
    now,
  }).start({
    ref,
    connection,
    turnId: "t1",
    signal: options.signal ?? new AbortController().signal,
  });
}

test("sends paragraphs in order after a fixed pause each and records them", async () => {
  const fake = fakeConnection();
  const pacing = fakeSleep();
  const reply = start(fake.connection, { sleep: pacing.sleep });
  reply.push("Hello.\n");
  reply.push("\nHow are ");
  reply.push("you?");
  expect(await reply.end()).toEqual({
    sentParts: 2,
    failed: false,
  });
  expect(pacing.requested).toEqual([750, 750]);
  expect(fake.typing).toEqual(["42", "42"]);
  expect(fake.stateAtSend).toEqual(["pending", "pending"]);
  expect(fake.sent).toEqual([
    { kind: "text", text: "Hello" },
    { kind: "text", text: "How are you?" },
  ]);
  const messages = (await store.load(ref)).messages;
  expect(messages[0]).toMatchObject({
    author: { role: "agent" },
    text: "Hello",
    delivery: "sent",
    platformId: "p1",
    sentAt: "2026-11-04T10:16:00.000Z",
    turnId: "t1",
  });
  expect(messages[1]).toMatchObject({ text: "How are you?", platformId: "p2" });
});

test("typing pacing sends the first part at once and paces later parts per word", async () => {
  const fake = fakeConnection();
  const pacing = fakeSleep();
  const reply = start(fake.connection, {
    sleep: pacing.sleep,
    settings: delivery({ pacing: "typing" }),
  });
  reply.push("Hi\n\none two three");
  await reply.end();
  expect(pacing.requested).toEqual([3000]);
  expect(fake.typing).toEqual(["42"]);
  expect(fake.sent.length).toBe(2);
});

test("complete timing sends nothing before the reply ends", async () => {
  const fake = fakeConnection();
  const pacing = fakeSleep();
  const reply = start(fake.connection, {
    sleep: pacing.sleep,
    settings: delivery({ timing: "complete" }),
  });
  reply.push("One.\n\nTwo.\n\n");
  await Bun.sleep(0);
  expect(pacing.requested).toEqual([]);
  expect(fake.sent).toEqual([]);
  await reply.end();
  expect(fake.sent).toEqual([
    { kind: "text", text: "One" },
    { kind: "text", text: "Two" },
  ]);
});

test("an abort during a pacing wait supersedes the remaining parts", async () => {
  const fake = fakeConnection();
  const pacing = fakeSleep({ manual: true });
  const controller = new AbortController();
  const reply = start(fake.connection, {
    sleep: pacing.sleep,
    signal: controller.signal,
  });
  reply.push("A\n\nB\n\nC");
  await pacing.requestedCount(1);
  pacing.releaseNext();
  await pacing.requestedCount(2);
  controller.abort("interrupted");
  expect(await reply.end()).toEqual({
    sentParts: 1,
    failed: false,
  });
  expect(fake.sent).toEqual([{ kind: "text", text: "A" }]);
  expect(await records()).toEqual([
    { text: "A", delivery: "sent", platformId: "p1" },
    { text: "B", delivery: "superseded" },
    { text: "C", delivery: "superseded" },
  ]);
});

test("a failure stops delivery and records the later parts as failed", async () => {
  const fake = fakeConnection([
    { status: "sent", platformId: "p1", sentAt },
    { status: "failed", error: "blocked by user" },
  ]);
  const reply = start(fake.connection);
  reply.push("A\n\nB\n\nC");
  expect(await reply.end()).toMatchObject({ sentParts: 1, failed: true });
  expect(fake.sent.length).toBe(2);
  expect(await records()).toEqual([
    { text: "A", delivery: "sent", platformId: "p1" },
    { text: "B", delivery: "failed", error: "blocked by user" },
    { text: "C", delivery: "failed", error: "not sent after earlier failure" },
  ]);
});

test("an uncertain outcome is logged and never resent", async () => {
  const fake = fakeConnection([{ status: "uncertain", error: "timeout" }]);
  const reply = start(fake.connection);
  reply.push("A\n\nB");
  expect(await reply.end()).toEqual({
    sentParts: 0,
    failed: false,
  });
  expect(fake.sent).toEqual([{ kind: "text", text: "A" }]);
  expect(await records()).toEqual([
    { text: "A", delivery: "uncertain", error: "timeout" },
    {
      text: "B",
      delivery: "failed",
      error: "not sent after uncertain delivery",
    },
  ]);
  expect(
    logLines.map((line) => (JSON.parse(line) as { event: string }).event),
  ).toEqual(["delivery.uncertain"]);
});

test("a failed record ends delivery with the error, and a second end does not throw", async () => {
  const fake = fakeConnection();
  const failing = { append: () => Promise.reject(new Error("disk full")) };
  const reply = start(fake.connection, { store: failing });
  reply.push("A\n\nB");
  const result = await reply.end();
  expect(result).toEqual({
    sentParts: 0,
    failed: false,
    error: new Error("disk full"),
  });
  expect(await reply.end()).toEqual(result);
  expect(fake.sent).toEqual([]);
});

test("a retryable failure waits and retries the same part", async () => {
  const fake = fakeConnection([
    { status: "failed", error: "rate limited", retryAfterMs: 2000 },
    { status: "failed", error: "rate limited", retryAfterMs: 2000 },
  ]);
  const pacing = fakeSleep();
  const reply = start(fake.connection, { sleep: pacing.sleep });
  reply.push("A");
  expect(await reply.end()).toMatchObject({ sentParts: 1, failed: false });
  expect(pacing.requested).toEqual([750, 2000, 2000]);
  expect(fake.sent.length).toBe(3);
  expect(await records()).toEqual([
    { text: "A", delivery: "sent", platformId: "p3" },
  ]);
});

test("a retryable failure stops after three attempts", async () => {
  const limited = {
    status: "failed",
    error: "rate limited",
    retryAfterMs: 2000,
  } as const;
  const fake = fakeConnection([limited, limited, limited, limited]);
  const reply = start(fake.connection);
  reply.push("A");
  expect(await reply.end()).toMatchObject({ sentParts: 0, failed: true });
  expect(fake.sent.length).toBe(3);
  expect(await records()).toEqual([
    { text: "A", delivery: "failed", error: "rate limited" },
  ]);
});

test("an approved video link is sent as a video and recorded", async () => {
  const fake = fakeConnection();
  const reply = start(fake.connection, {
    settings: delivery({
      video: {
        linkPrefixes: ["https://videos.example.com/"],
        mode: "attachment",
        surroundingText: "replace",
      },
    }),
  });
  reply.push("Watch https://videos.example.com/a.mp4");
  await reply.end();
  expect(fake.sent).toEqual([
    { kind: "video", url: "https://videos.example.com/a.mp4" },
  ]);
  expect(await records()).toEqual([
    {
      text: "[video] https://videos.example.com/a.mp4",
      delivery: "sent",
      platformId: "p1",
    },
  ]);
});
