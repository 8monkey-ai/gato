import { expect, test } from "bun:test";

import {
  at,
  channel,
  ref,
  seed,
  setup,
  useCheckerFixture,
} from "./checker-fixture.ts";

useCheckerFixture();

test("a paused chat gets no nudge under the unrestricted policy", async () => {
  await seed();
  const { store, checker, runs } = await setup(channel(), {
    policy: "unrestricted",
  });
  await store.writeTextFile(ref, "paused", "Ana handles this\n");
  at(35);
  await checker.checkOnce();
  expect(runs).toEqual([]);
});

test("deleting the paused file is reported once, and the first check only records the state", async () => {
  await seed();
  const other = { connectionId: "tg", chatId: "7" };
  await seed(other);
  const { store, checker, stateChanges } = await setup();
  await store.writeTextFile(ref, "paused", "Ana handles this\n");
  await checker.checkOnce();
  expect(stateChanges).toEqual([]);
  await store.removeFile(ref, "paused");
  await checker.checkOnce();
  await checker.checkOnce();
  expect(stateChanges).toEqual(["42:human->agent"]);
});

test("state fetches and nudges run no more than the configured number at once", async () => {
  const chats = ["1", "2", "3"].map((chatId) => ({
    connectionId: "tg",
    chatId,
  }));
  for (const chat of chats) await seed(chat);
  let active = 0;
  let most = 0;
  const held = async <T>(value: T) => {
    most = Math.max(most, ++active);
    await new Promise(setImmediate);
    active--;
    return value;
  };
  const connection = channel({
    assignment: {
      fetchState: () => held({ owner: "agent" as const, open: true }),
    },
  });
  const { checker, runs } = await setup(connection, {
    concurrency: 1,
    runTurn: () => held(undefined),
  });
  at(35);
  await checker.checkOnce();
  expect(runs.map((r) => r.chatId).sort()).toEqual(["1", "2", "3"]);
  expect(most).toBe(1);
});
