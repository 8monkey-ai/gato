import { afterEach, expect, test } from "bun:test";

import { readChat, waitUntil } from "./support/app.ts";
import { isPreparationCall } from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const turnEntry = () =>
  waitUntil(
    async () =>
      (await readChat(world.dataDir, world.telegram.connectionId, "42")).find(
        (e) => e.tag === "turn",
      ),
    5000,
  );

test("§6 reaching the model call limit stops the turn and records the outcome", async () => {
  world = await createWorld();
  world.llm.respond(() => ({
    toolCalls: [{ name: "read_skill", args: { skill: "menu" } }],
  }));
  await world.start({ TURN_MAX_MODEL_CALLS: "2" });
  world.telegram.push(42, { text: "Loop" });

  const turn = await turnEntry();
  expect(turn.meta.outcome).toBe("failed");
  expect(turn.text).toBe("The turn reached its limit of 2 model calls");
  expect(world.llm.requests).toHaveLength(2);
  expect(world.telegram.sent).toHaveLength(0);
});

test("§6 preparation calls count toward the model call limit", async () => {
  world = await createWorld();
  world.telegram.files.set("p", new Uint8Array([1, 2, 3]));
  world.llm.respond(() => ({ text: "A cup." }));
  await world.start({
    TURN_MAX_MODEL_CALLS: "1",
    IMAGE_PREPARATION_MODEL: "test/vision",
  });
  world.telegram.push(42, {
    photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
  });

  expect((await turnEntry()).meta.outcome).toBe("failed");
  expect(world.llm.requests.map(isPreparationCall)).toEqual([true]);
});

test("§6 reaching the time limit stops the turn as timed out", async () => {
  world = await createWorld();
  world.llm.respond(() => ({ text: "Too late.", hangMs: 3000 }));
  await world.start({ TURN_TIMEOUT_SECONDS: "0.5" });
  world.telegram.push(42, { text: "Hi" });

  expect((await turnEntry()).meta.outcome).toBe("timed-out");
  expect(world.telegram.sent).toHaveLength(0);
});

test("§6 respond.io uses the platform route by default and a configured channel when set", async () => {
  world = await createWorld();
  let app = await world.start({}, "respondio");
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Hi" }),
    world.respondio.signingKey,
  );
  await waitUntil(() => world.respondio.sent.length);
  await app.stop();
  app = await world.start(
    { RESPONDIO_MAIN_REPLY_CHANNEL_ID: "99" },
    "respondio",
  );
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Again" }),
    world.respondio.signingKey,
  );
  await waitUntil(() => world.respondio.sent.length === 2);

  expect(world.respondio.sent.map((s) => s.channelId)).toEqual([undefined, 99]);
});
