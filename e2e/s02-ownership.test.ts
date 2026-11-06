import { afterEach, expect, test } from "bun:test";

import { readChat, waitUntil } from "./support/app.ts";
import { contentText, lastUserText } from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const customer = (app: { url: string }, text: string) =>
  notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text }),
    world.respondio.signingKey,
  );

test("§2 a human-owned conversation is recorded only, and the return to the agent sends nothing", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  world.respondio.assign("5", 3);
  await customer(app, "Are you there?");
  await app.waitForLog("turn.not_agent_owned");
  world.respondio.assign("5", null);
  await Bun.sleep(300);
  expect(world.respondio.sent).toHaveLength(0);

  await customer(app, "Hello again");
  await waitUntil(() => world.respondio.sent.length);
  expect(world.llm.requests).toHaveLength(1);
  expect(lastUserText(world.llm.requests[0]!)).toBe("Hello again");
});

test("§2 a conversation assigned to the configured agent user is answered", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  world.respondio.assign("5", 77);
  await customer(app, "Hi");
  await waitUntil(() => world.respondio.sent.length);
  expect(world.respondio.sent[0]?.message.text).toBe("Hello from the agent.");
});

test("§2 a human who takes ownership lets the current reply finish", async () => {
  world = await createWorld();
  world.llm.respond(() => ({
    text: "One.\n\nTwo two two two.\n\nThree three.",
  }));
  const app = await world.start(
    { DELIVERY_PACING: "typing", DELIVERY_TYPING_SECONDS_PER_WORD: "0.1" },
    "respondio",
  );
  await customer(app, "Hi");
  await waitUntil(() => world.respondio.sent.length);
  world.respondio.assign("5", 3);

  await waitUntil(() => world.respondio.sent.length === 3, 3000);
  await customer(app, "More please");
  await app.waitForLog("turn.not_agent_owned");
  expect(world.respondio.sent.map((s) => s.message.text)).toEqual([
    "One.",
    "Two two two two.",
    "Three three.",
  ]);
});

test("§2 a new customer message stops unsent parts and the next turn sees only delivered parts", async () => {
  world = await createWorld();
  world.llm.respond((request) =>
    lastUserText(request) === "Hi"
      ? { text: "One.\n\nTwo two two two two two.\n\nThree." }
      : { text: "Got it." },
  );
  await world.start({
    DELIVERY_PACING: "typing",
    DELIVERY_TYPING_SECONDS_PER_WORD: "0.3",
  });
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length, 3000);
  world.telegram.push(42, { text: "Wait, another question" });

  await waitUntil(
    () => world.telegram.sent.some((s) => s.text === "Got it."),
    5000,
  );
  expect(world.telegram.sent.map((s) => s.text)).toEqual(["One.", "Got it."]);
  const second = world.llm.mainRequests()[1]!;
  const visible = second.messages
    .filter((m) => m.role !== "system")
    .map((m) => [m.role, contentText(m.content)]);
  expect(visible).toEqual([
    ["user", "Hi"],
    ["assistant", "One."],
    ["user", "Wait, another question"],
  ]);
  const chat = await readChat(world.dataDir, world.telegram.connectionId, "42");
  expect(
    chat.filter((e) => e.meta.delivery === "unsent").map((e) => e.text),
  ).toEqual(["Two two two two two two.", "Three."]);
  expect(chat.find((e) => e.tag === "turn")?.meta.outcome).toBe("interrupted");
});

test("§2 conversations progress independently while one turn is slow", async () => {
  world = await createWorld();
  world.llm.respond((request) =>
    lastUserText(request) === "slow"
      ? { text: "Late.", hangMs: 1500 }
      : { text: "Fast." },
  );
  await world.start();
  world.telegram.push(1, { text: "slow" });
  await Bun.sleep(100);
  world.telegram.push(2, { text: "quick" });

  await waitUntil(() => world.telegram.sent.length === 2, 4000);
  expect(world.telegram.sent.map((s) => [s.chat_id, s.text])).toEqual([
    ["2", "Fast."],
    ["1", "Late."],
  ]);
});
