import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { createLogger } from "../log.ts";
import type {
  ChatRef,
  EntryBody,
  TurnEnd,
  TurnTrigger,
} from "../record/types.ts";
import { type NewEntry, openChatStore } from "../storage/chat-store.ts";
import { createControls } from "./controls.ts";
import { createScheduler } from "./scheduler.ts";

let dataDir = "";
const ref = { connectionId: "tg", chatId: "42" };
const log = createLogger({}, () => {});
const now = () => new Date("2026-11-04T10:15:00.000Z");

const visible = (
  id: string,
  role: "customer" | "agent",
  sentAt: string,
): EntryBody => ({
  type: "message",
  message: {
    id,
    author: { role },
    sentAt,
    text: id,
    attachments: [],
    delivery: role === "agent" ? "sent" : "observed",
  },
});

type Call = { chatId: string; trigger: TurnTrigger; signal: AbortSignal };

function fakeTurns(blockFirst: boolean) {
  const calls: Call[] = [];
  const waiters: (() => void)[] = [];
  const runTurn = (r: ChatRef, trigger: TurnTrigger, signal: AbortSignal) => {
    calls.push({ chatId: r.chatId, trigger, signal });
    waiters.splice(0).forEach((wake) => wake());
    return blockFirst && calls.length === 1
      ? new Promise<TurnEnd>((resolve) =>
          signal.addEventListener("abort", () => resolve("interrupted")),
        )
      : Promise.resolve<TurnEnd>("completed");
  };
  const started = (count: number): Promise<void> =>
    calls.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push(resolve)).then(() =>
          started(count),
        );
  return { calls, runTurn, started };
}

async function setup(
  entries: NewEntry[],
  { native = false, blockFirst = true } = {},
) {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  if (entries.length > 0) await store.append(ref, entries);
  const channel = {
    assignment: native
      ? {
          fetchState: () =>
            Promise.resolve({ owner: "none" as const, open: true }),
        }
      : undefined,
  } as ChannelConnection;
  const labels = { handoff: "h", outOfScope: "o", error: "e", expired: "x" };
  const controls = createControls({
    store,
    connection: () => channel,
    labels,
    log,
  });
  const turns = fakeTurns(blockFirst);
  const scheduler = createScheduler({
    store,
    controls,
    policy: "assigned",
    runTurn: turns.runTurn,
    log,
  });
  return { store, scheduler, ...turns };
}

const ownedByAgent: NewEntry = {
  type: "ownership",
  owner: "agent",
  eventAt: "2026-11-04T10:00:00.000Z",
};

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-scheduler-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

test("a new customer message interrupts the running turn and a new turn follows", async () => {
  const { scheduler, calls, started } = await setup([]);
  scheduler.customerMessage(ref);
  await started(1);
  expect(scheduler.busy(ref)).toBe(true);
  scheduler.customerMessage(ref);
  await started(2);
  expect(calls.map((c) => [c.trigger, c.signal.reason as unknown])).toEqual([
    ["customer", "interrupted"],
    ["customer", undefined],
  ]);
  await scheduler.stop(1000);
  expect(scheduler.busy(ref)).toBe(false);
});

test("a human takeover does not interrupt the running turn", async () => {
  const { scheduler, calls, started } = await setup([]);
  scheduler.customerMessage(ref);
  await started(1);
  scheduler.ownershipChange(ref, "agent", "human");
  expect(calls[0]?.signal.aborted).toBe(false);
  await scheduler.stop(0);
  expect(calls.map((c) => [c.trigger, c.signal.reason as unknown])).toEqual([
    ["customer", "shutdown"],
  ]);
});

test("reassignment to the agent reviews a waiting customer message", async () => {
  const { scheduler, calls, started } = await setup(
    [visible("m1", "customer", "2026-11-04T10:00:00.000Z"), ownedByAgent],
    { native: true },
  );
  scheduler.ownershipChange(ref, "none", "agent");
  await started(1);
  scheduler.ownershipChange(ref, "agent", "agent");
  await scheduler.stop(0);
  expect(calls.map((c) => c.trigger)).toEqual(["review"]);
});

test("reassignment without a waiting customer message records a skip note", async () => {
  const { store, scheduler, calls } = await setup(
    [
      visible("m1", "customer", "2026-11-04T10:00:00.000Z"),
      visible("m2", "agent", "2026-11-04T10:01:00.000Z"),
      ownedByAgent,
    ],
    { native: true },
  );
  scheduler.ownershipChange(ref, "human", "agent");
  await scheduler.stop(1000);
  expect(calls).toEqual([]);
  expect(
    (await store.load(ref)).notes.map((n) => [n.by, n.kind, n.text]),
  ).toEqual([["system", "skip", "No customer request awaits an answer"]]);
});

test("recovery closes abandoned turns, marks pending parts uncertain and answers only accepted input", async () => {
  const { store, scheduler, calls } = await setup(
    [
      {
        ...visible("m1", "customer", "2026-11-04T10:00:00.000Z"),
        eventId: "e1",
      },
      {
        type: "turn-start",
        turnId: "t1",
        trigger: "customer",
        inputThroughSeq: 1,
        instructionsRevision: "r1",
      },
      {
        type: "message",
        message: {
          id: "m2",
          author: { role: "agent" },
          sentAt: "2026-11-04T10:01:00.000Z",
          attachments: [],
          delivery: "pending",
        },
      },
    ],
    { blockFirst: false },
  );
  const migrated = { connectionId: "tg", chatId: "7" };
  await store.append(migrated, [
    visible("m9", "customer", "2026-11-04T09:00:00.000Z"),
  ]);
  await scheduler.recover();
  await scheduler.stop(1000);
  expect(calls.map((c) => [c.chatId, c.trigger])).toEqual([["42", "customer"]]);
  const view = await store.load(ref);
  expect(view.turns.map((t) => [t.end?.outcome, t.end?.reason])).toEqual([
    ["interrupted", "abandoned at restart"],
  ]);
  expect(view.messages.map((m) => m.delivery)).toEqual([
    "observed",
    "uncertain",
  ]);
  expect((await store.load(migrated)).lastSeq).toBe(1);
});

test("an exclusive run returns the turn outcome and a thrown turn counts as failed", async () => {
  const { scheduler } = await setup([], { blockFirst: false });
  expect(await scheduler.runExclusive(ref, "nudge")).toBe("completed");
  const failing = createScheduler({
    store: await openChatStore(dataDir, { timeZone: "UTC", log, now }),
    controls: {
      state: () => Promise.reject(new Error("unused")),
      note: () => Promise.resolve(),
    },
    policy: "assigned",
    runTurn: () => Promise.reject(new Error("boom")),
    log,
  });
  expect(await failing.runExclusive(ref, "nudge")).toBe("failed");
});

test("a busy chat refuses an exclusive run and a stopped scheduler starts nothing", async () => {
  const { scheduler, calls, started } = await setup([]);
  const first = scheduler.runExclusive(ref, "nudge");
  await started(1);
  expect(await scheduler.runExclusive(ref, "nudge")).toBe("busy");
  await scheduler.stop(0);
  expect(await first).toBe("interrupted");
  scheduler.customerMessage(ref);
  expect(await scheduler.runExclusive(ref, "nudge")).toBe("busy");
  expect(calls.length).toBe(1);
});
