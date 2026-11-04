import { expect, test } from "bun:test";

import {
  loggedEvents,
  ownedByAgent,
  ref,
  setup,
  state,
  useSchedulerFixture,
  visible,
} from "./scheduler-fixture.ts";

useSchedulerFixture();

test("a paused chat gets no turn under the unrestricted policy", async () => {
  const { store, scheduler, calls } = await setup([], {
    policy: "unrestricted",
  });
  await store.writeTextFile(ref, "paused", "Ana handles this\n");
  scheduler.customerMessage(ref);
  await scheduler.stop(1000);
  expect(calls).toEqual([]);
});

test("a native chat is reconciled before its first turn", async () => {
  const { store, scheduler, calls } = await setup(
    [visible("m1", "customer", "2026-11-04T10:00:00.000Z")],
    { native: true, blockFirst: false },
  );
  scheduler.customerMessage(ref);
  await scheduler.stop(1000);
  expect(calls.map((c) => c.trigger)).toEqual(["customer"]);
  expect((await store.load(ref)).ownership?.owner).toBe("agent");
});

test("an unavailable native state lets replies use the recorded state but not nudges", async () => {
  const { scheduler, calls } = await setup([ownedByAgent], {
    native: true,
    blockFirst: false,
    fetchState: () => Promise.reject(new Error("down")),
  });
  expect(await scheduler.runExclusive(ref, "nudge")).toBe("skipped");
  scheduler.customerMessage(ref);
  await scheduler.stop(1000);
  expect(calls.map((c) => c.trigger)).toEqual(["customer"]);
  expect(loggedEvents().filter((e) => e === "reconcile.failed").length).toBe(2);
});

test("an exclusive run calls beforeRun only after admission", async () => {
  const order: string[] = [];
  const { store, scheduler } = await setup([], { blockFirst: false });
  const beforeRun = () => order.push("before");
  expect(await scheduler.runExclusive(ref, "nudge", { beforeRun })).toBe(
    "completed",
  );
  await store.writeTextFile(ref, "closed", "");
  expect(await scheduler.runExclusive(ref, "nudge", { beforeRun })).toBe(
    "skipped",
  );
  expect(order).toEqual(["before"]);
});

test("abort stops the running turn with its reason and drops the queued turn", async () => {
  const { scheduler, calls, started } = await setup([]);
  scheduler.customerMessage(ref);
  await started(1);
  const run = calls[0];
  if (run)
    run.signal.addEventListener("abort", () => scheduler.customerMessage(ref));
  scheduler.stateChanged(ref, state("none"), state("agent"));
  await scheduler.abort(ref, "merged");
  expect(scheduler.busy(ref)).toBe(false);
  await scheduler.stop(1000);
  expect(calls.map((c) => [c.trigger, c.signal.reason as unknown])).toEqual([
    ["customer", "merged"],
  ]);
});

test("a run stopped while its native state loads writes no skip note", async () => {
  let releaseFetch: () => void = () => {};
  const held = new Promise<void>((resolve) => (releaseFetch = resolve));
  let fetches = 0;
  const { store, scheduler, calls } = await setup(
    [ownedByAgent, visible("m1", "agent", "2026-11-04T10:00:00.000Z")],
    {
      native: true,
      fetchState: async () => {
        fetches++;
        await held;
        return { owner: "agent", open: true };
      },
    },
  );
  scheduler.stateChanged(ref, state("none"), state("agent"));
  while (fetches === 0) await Bun.sleep(1);
  const stopped = scheduler.stop(0);
  releaseFetch();
  await stopped;
  expect(calls).toEqual([]);
  expect((await store.load(ref)).notes).toEqual([]);
});
