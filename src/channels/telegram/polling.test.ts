import { expect, test } from "bun:test";

import type { Update } from "grammy/types";

import type { Wait } from "./polling.ts";
import { telegramFake } from "./telegram-fixture.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const textUpdate = {
  update_id: 7,
  message: {
    message_id: 42,
    date: 1_700_000_000,
    chat: { id: 555, type: "private", first_name: "Ana" },
    from: { id: 555, is_bot: false, first_name: "Ana" },
    text: "Hello",
  },
} as unknown as Update;

test("restarts polling after a failed update and receives it again", async () => {
  const waiting = deferred();
  const restart = deferred();
  const delivered = deferred();
  const delays: number[] = [];
  const wait: Wait = (ms) => {
    delays.push(ms);
    waiting.resolve();
    return restart.promise;
  };
  const fake = telegramFake({ updates: [textUpdate], wait });
  const received: string[] = [];
  let attempts = 0;
  await fake.connection.start((event) => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("disk full"));
    received.push(event.eventId);
    delivered.resolve();
    return Promise.resolve();
  });
  await waiting.promise;
  expect([fake.connection.healthy?.(), delays]).toEqual([false, [5000]]);
  restart.resolve();
  await delivered.promise;
  expect([fake.connection.healthy?.(), received]).toEqual([true, ["update:7"]]);
  await fake.connection.stop();
  expect(fake.events()).toEqual([
    "telegram.update_failed",
    "telegram.polling_stopped",
    "telegram.polling_restarted",
  ]);
});

test("stopping polling is not a failure", async () => {
  const delays: number[] = [];
  const wait: Wait = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  const fake = telegramFake({ wait });
  await fake.connection.start(() => Promise.resolve());
  await fake.connection.stop();
  await Bun.sleep(0);
  expect([fake.connection.healthy?.(), delays, fake.events()]).toEqual([
    true,
    [],
    [],
  ]);
});
