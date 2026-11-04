import { expect, test } from "bun:test";

import {
  at,
  channel,
  logged,
  notes,
  ref,
  seed,
  setup,
  useCheckerFixture,
} from "./checker-fixture.ts";

useCheckerFixture();

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
  expect((await notes(busy.store)).length).toBe(2);
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
    logged().filter((l) => l.event === "expiry.exemption_labels_unavailable")
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
  const { store, checker, runs, stateChanges } = await setup(connection);
  at(35);
  await checker.checkOnce();
  expect(runs).toEqual([]);
  expect(checker.readiness().unreconciledChats).toBe(1);
  await checker.checkOnce();
  expect(stateChanges).toEqual(["42:none->agent"]);
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
  expect(logged().filter((l) => l.event === "nudge.check_failed").length).toBe(
    1,
  );
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
