import { expect, test } from "bun:test";

import { project } from "../record/projection.ts";
import { openChatStore } from "../storage/chat-store.ts";
import {
  dirs,
  log,
  now,
  ownedByAgent,
  ref,
  setup,
  state,
  useSchedulerFixture,
  visible,
} from "./scheduler-fixture.ts";
import { createScheduler } from "./scheduler.ts";

useSchedulerFixture();

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
  scheduler.stateChanged(ref, state("agent"), state("human"));
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
  scheduler.stateChanged(ref, state("none"), state("agent"));
  await started(1);
  scheduler.stateChanged(ref, state("agent"), state("agent"));
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
  scheduler.stateChanged(ref, state("human"), state("agent"));
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
    store: await openChatStore(dirs().dataDir, { timeZone: "UTC", log, now }),
    controls: {
      state: () => Promise.resolve({ ...state("agent"), view: project([]) }),
      note: () => Promise.resolve(),
    },
    policy: "assigned",
    reconcile: () => Promise.resolve(true),
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

test("reopening a chat reviews a waiting customer message", async () => {
  const { scheduler, calls, started } = await setup([
    visible("m1", "customer", "2026-11-04T10:00:00.000Z"),
  ]);
  scheduler.stateChanged(ref, state("agent", false), state("agent"));
  await started(1);
  await scheduler.stop(0);
  expect(calls.map((c) => c.trigger)).toEqual(["review"]);
});
