import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { type Controls, createControls } from "../conversation/controls.ts";
import { createLogger } from "../log.ts";
import type { ChatRef, EntryBody, TurnEnd } from "../record/types.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { createNudgeChecker } from "./checker.ts";

const T = Date.parse("2026-11-04T10:00:00.000Z");
const minute = 60_000;
const ref = { connectionId: "tg", chatId: "42" };
let dataDir = "";
let clock = new Date(T);
let logs: { level: string; event: string; chatId?: string }[] = [];
const log = createLogger({}, (line) => {
  logs.push(JSON.parse(line) as { level: string; event: string });
});
const settings = {
  ownershipPolicy: "assigned" as const,
  timeZone: "UTC",
  nudges: {
    enabled: true,
    expiryEnabled: true,
    checkIntervalMs: 300_000,
    milestonesMs: [300_000, 2_100_000, 45_300_000, 45_900_000],
    hours: { startMinutes: 0, endMinutes: 1440 },
    prompt: "Nudge",
    expiryAfterMs: 49_500_000,
    expiryExemptLabel: "out-of-scope-unsolved",
  },
};

const message = (
  id: string,
  role: "customer" | "agent",
  offsetMinutes: number,
): EntryBody => ({
  type: "message",
  message: {
    id,
    author: { role },
    sentAt: new Date(T + offsetMinutes * minute).toISOString(),
    text: id,
    attachments: [],
    delivery: role === "agent" ? "sent" : "observed",
  },
});

function channel(extra: Partial<ChannelConnection> = {}): ChannelConnection {
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

async function setup(
  connection = channel(),
  options: {
    outcome?: TurnEnd | "busy";
    wrap?: (controls: Controls) => Controls;
  } = {},
) {
  const { outcome = "completed", wrap = (c: Controls) => c } = options;
  const store = await openChatStore(dataDir, {
    timeZone: "UTC",
    log,
    now: () => clock,
  });
  const labels = { handoff: "h", outOfScope: "o", error: "e", expired: "x" };
  const controls = createControls({
    store,
    connection: () => connection,
    labels,
    log,
  });
  const runs: { chatId: string; trigger: string; nudgeNotes: number }[] = [];
  const ownerChanges: string[] = [];
  const scheduler = {
    busy: () => false,
    ownershipChange: (r: ChatRef, previous: string, owner: string) =>
      ownerChanges.push(`${r.chatId}:${previous}->${owner}`),
    runExclusive: async (r: ChatRef, trigger: string) => {
      const notes = (await store.load(r)).notes;
      runs.push({
        chatId: r.chatId,
        trigger,
        nudgeNotes: notes.filter((n) => n.kind === "nudge").length,
      });
      return outcome;
    },
  };
  const checker = createNudgeChecker({
    store,
    controls: wrap(controls),
    scheduler,
    connection: () => connection,
    settings,
    log,
    now: () => clock,
  });
  return { store, checker, runs, ownerChanges };
}

const at = (minutes: number) => {
  clock = new Date(T + minutes * minute);
};
const notes = async (
  store: Awaited<ReturnType<typeof openChatStore>>,
  r: ChatRef = ref,
) => (await store.load(r)).notes.map((n) => [n.by, n.kind, n.text]);

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-checker-"));
  logs = [];
  clock = new Date(T);
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

async function seed(r: ChatRef = ref) {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log });
  await store.append(r, [message(`c-${r.chatId}`, "customer", 0)]);
  await store.append(r, [message(`a-${r.chatId}`, "agent", 6)]);
}

test("agent activity at minute 6 gives no nudge at minute 34 and one nudge at minute 35", async () => {
  await seed();
  const { store, checker, runs } = await setup();
  at(34);
  await checker.checkOnce();
  expect(runs).toEqual([]);
  at(35);
  await checker.checkOnce();
  await checker.checkOnce();
  expect(runs).toEqual([{ chatId: "42", trigger: "nudge", nudgeNotes: 1 }]);
  expect(await notes(store)).toEqual([["agent", "nudge", "Nudge"]]);
  expect(checker.readiness()).toEqual({
    reconciledChats: 1,
    unreconciledChats: 0,
    lastCheckAt: "2026-11-04T10:35:00.000Z",
  });
});

test("a failed nudge records a failure note and a busy chat records none", async () => {
  await seed();
  const { store, checker } = await setup(channel(), { outcome: "timed-out" });
  at(35);
  await checker.checkOnce();
  expect(await notes(store)).toEqual([
    ["agent", "nudge", "Nudge"],
    ["system", "nudge-failed", "Nudge failed: timed-out"],
  ]);
  const busy = await setup(channel(), { outcome: "busy" });
  at(12 * 60 + 36);
  await busy.checker.checkOnce();
  expect((await notes(busy.store)).length).toBe(3);
});

test("a restarted checker does not repeat a committed nudge", async () => {
  await seed();
  at(35);
  await (await setup()).checker.checkOnce();
  at(40);
  const restarted = await setup();
  await restarted.checker.checkOnce();
  expect(restarted.runs).toEqual([]);
});

const nativeChannel = (read: () => Promise<string[]>) =>
  channel({
    assignment: {
      fetchState: () => Promise.resolve({ owner: "agent", open: true }),
    },
    labels: { add: () => Promise.resolve(), read },
  });

test("expiry hands off once and later checks do not expire again", async () => {
  await seed();
  const { store, checker, runs } = await setup(
    nativeChannel(() => Promise.resolve(["vip"])),
  );
  at(13 * 60 + 45);
  await checker.checkOnce();
  at(14 * 60);
  await checker.checkOnce();
  const view = await store.load(ref);
  expect(runs).toEqual([]);
  expect(view.handoffs.map((h) => [h.path, h.reason])).toEqual([
    ["expiry", "Expired: no customer reply for 13h 45m"],
  ]);
  expect(view.notes.filter((n) => n.kind === "expiry").length).toBe(1);
});

test("unavailable exemption labels skip expiry with a warning while nudges continue", async () => {
  await seed();
  const { store, checker, runs } = await setup(
    nativeChannel(() => Promise.reject(new Error("down"))),
  );
  at(13 * 60 + 45);
  await checker.checkOnce();
  expect(runs.map((r) => r.trigger)).toEqual(["nudge"]);
  expect((await store.load(ref)).handoffs).toEqual([]);
  expect(
    logs.filter((l) => l.event === "expiry.exemption_labels_unavailable")
      .length,
  ).toBe(1);
});

test("a native chat is skipped until its state is fetched once", async () => {
  await seed();
  let fetches = 0;
  const connection = channel({
    assignment: {
      fetchState: () =>
        ++fetches === 1
          ? Promise.reject(new Error("down"))
          : Promise.resolve({ owner: "agent", open: true }),
    },
  });
  const { store, checker, runs, ownerChanges } = await setup(connection);
  at(35);
  await checker.checkOnce();
  expect(runs).toEqual([]);
  expect(checker.readiness().unreconciledChats).toBe(1);
  await checker.checkOnce();
  expect(ownerChanges).toEqual(["42:none->agent"]);
  at(12 * 60 + 36);
  await checker.checkOnce();
  expect(fetches).toBe(2);
  expect(runs.length).toBe(2);
  expect(checker.readiness().reconciledChats).toBe(1);
  const view = await store.load(ref);
  expect(view.ownership).toEqual({
    owner: "agent",
    eventAt: "2026-11-04T10:35:00.000Z",
  });
  expect(view.open).toBeUndefined();
});

test("a failing chat does not stop the other chats", async () => {
  await seed();
  await seed({ connectionId: "tg", chatId: "7" });
  const { checker, runs } = await setup(channel(), {
    wrap: (c) => ({
      ...c,
      state: (r) =>
        r.chatId === "42" ? Promise.reject(new Error("boom")) : c.state(r),
    }),
  });
  at(35);
  await checker.checkOnce();
  expect(runs.map((r) => r.chatId)).toEqual(["7"]);
  expect(logs.filter((l) => l.event === "nudge.check_failed").length).toBe(1);
});

test("a stopped checker starts no check, and a running check finishes before settled resolves", async () => {
  await seed();
  let releaseState: () => void = () => {};
  const held = new Promise<void>((resolve) => (releaseState = resolve));
  const { store, checker, runs } = await setup(channel(), {
    wrap: (c) => ({ ...c, state: (r) => held.then(() => c.state(r)) }),
  });
  at(35);
  const running = checker.checkOnce();
  checker.stop();
  releaseState();
  await checker.settled();
  await running;
  await checker.checkOnce();
  expect(runs).toEqual([]);
  expect(await notes(store)).toEqual([]);
});
