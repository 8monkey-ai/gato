import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { readChat, waitUntil } from "./support/app.ts";
import { lastUserText } from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const chatOf = (contact = "5", connection = "respondio-main") =>
  readChat(world.dataDir, connection, contact);
const turnsOf = async (contact = "5", connection = "respondio-main") =>
  (await chatOf(contact, connection)).filter((e) => e.tag === "turn");

test("§1 a Telegram customer message is recorded and answered in its chat", async () => {
  world = await createWorld();
  world.llm.respond((request) => ({
    text: `You said: ${lastUserText(request)}`,
  }));
  await world.start();
  world.telegram.push(42, { text: "Hi there" });

  const sent = await waitUntil(() => world.telegram.sent[0], 5000, "a reply");
  expect(sent).toMatchObject({ chat_id: "42", text: "You said: Hi there" });
  await waitUntil(
    async () => (await turnsOf("42", world.telegram.connectionId)).length,
  );
  const chat = await chatOf("42", world.telegram.connectionId);
  expect(chat.map((e) => [e.tag, e.text, e.meta.delivery])).toEqual([
    ["customer", "Hi there", undefined],
    ["agent", "You said: Hi there", "sent"],
    ["turn", undefined, undefined],
  ]);
  expect(chat[2]?.meta).toMatchObject({
    trigger: "customer",
    outcome: "completed",
  });
});

test("§1 a repeated notification records one message and sends one reply", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  const event = messageEvent({
    contact: 5,
    traffic: "incoming",
    text: "Hello",
  });
  for (let i = 0; i < 3; i++)
    await notify(app.url, "main", event, world.respondio.signingKey);

  await waitUntil(async () => (await turnsOf()).length);
  await Bun.sleep(200);
  expect((await chatOf()).filter((e) => e.tag === "customer")).toHaveLength(1);
  expect(world.respondio.sent).toHaveLength(1);
});

test("§1 operator, workflow, and unknown senders are attributed and never answered", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  const key = world.respondio.signingKey;
  await notify(
    app.url,
    "main",
    messageEvent({
      contact: 5,
      traffic: "outgoing",
      text: "I am Bob",
      sender: { source: "user", userId: 3 },
    }),
    key,
  );
  await notify(
    app.url,
    "main",
    messageEvent({
      contact: 5,
      traffic: "outgoing",
      text: "Welcome!",
      sender: { source: "workflow" },
    }),
    key,
  );
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "outgoing", text: "From phone" }),
    key,
  );

  await Bun.sleep(300);
  const chat = await chatOf();
  expect(chat.map((e) => [e.tag, e.meta.sender, e.text])).toEqual([
    ["operator", "user:3", "I am Bob"],
    ["workflow", undefined, "Welcome!"],
    ["operator", "unknown", "From phone"],
  ]);
  expect(world.llm.requests).toHaveLength(0);
});

test("§1 the channel echo of an agent send updates the original record", async () => {
  world = await createWorld();
  world.llm.respond(() => ({ text: "Sure, one moment." }));
  const app = await world.start({}, "respondio");
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Hi" }),
    world.respondio.signingKey,
  );
  const sent = await waitUntil(() => world.respondio.sent[0]);
  const echo = messageEvent({
    contact: 5,
    traffic: "outgoing",
    text: "Sure, one moment.",
    sender: { source: "api" },
    messageId: sent.messageId,
  });
  await notify(app.url, "main", echo, world.respondio.signingKey);

  await waitUntil(async () =>
    (await chatOf()).some((e) => e.meta.delivery === "confirmed"),
  );
  const agent = (await chatOf()).filter((e) => e.tag === "agent");
  expect(agent.map((e) => [e.text, e.meta.ref])).toEqual([
    ["Sure, one moment.", String(sent.messageId)],
  ]);
  expect(world.llm.requests).toHaveLength(1);
});

test("§1 notifications without a valid signature are refused and not recorded", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  const response = await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "x" }),
    "wrong-key",
  );

  expect(response.status).toBe(401);
  expect(await chatOf()).toEqual([]);
});

test("§1 malformed notifications are logged without running the agent and others are ignored", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  const malformed = await notify(
    app.url,
    "main",
    { event_type: "message.received", contact: {} },
    world.respondio.signingKey,
  );
  const irrelevant = await notify(
    app.url,
    "main",
    { event_type: "contact.tag.updated" },
    world.respondio.signingKey,
  );

  expect([malformed.status, irrelevant.status]).toEqual([200, 200]);
  await app.waitForLog("respondio.malformed_notification");
  expect(world.llm.requests).toHaveLength(0);
});

test("§1 work that cannot be saved is not acknowledged", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  await Bun.write(join(world.dataDir, "respondio-main", "5"), "not a folder");
  const event = messageEvent({
    contact: 5,
    traffic: "incoming",
    text: "Hello",
  });

  expect(
    (await notify(app.url, "main", event, world.respondio.signingKey)).status,
  ).toBe(500);
  await Bun.$`rm ${join(world.dataDir, "respondio-main", "5")}`;
  await mkdir(join(world.dataDir, "respondio-main", "5"));
  expect(
    (await notify(app.url, "main", event, world.respondio.signingKey)).status,
  ).toBe(200);
  expect((await chatOf()).filter((e) => e.tag === "customer")).toHaveLength(1);
});

test("§1 a delayed message takes its original place in the history", async () => {
  world = await createWorld();
  const app = await world.start({}, "respondio");
  const now = Math.floor(Date.now() / 1000);
  await notify(
    app.url,
    "main",
    messageEvent({
      contact: 5,
      traffic: "outgoing",
      text: "second",
      timestamp: now,
      sender: { source: "user", userId: 3 },
    }),
    world.respondio.signingKey,
  );
  await notify(
    app.url,
    "main",
    messageEvent({
      contact: 5,
      traffic: "outgoing",
      text: "first",
      timestamp: now - 60,
      sender: { source: "user", userId: 3 },
    }),
    world.respondio.signingKey,
  );

  await waitUntil(async () => (await chatOf()).length === 2);
  expect((await chatOf()).map((e) => e.text)).toEqual(["first", "second"]);
});

test("§1 contacts with the same identifier on different connections stay isolated", async () => {
  world = await createWorld();
  world.llm.respond((request) => ({
    text: `Reply to ${lastUserText(request)}`,
  }));
  const app = await world.start({}, "both");
  world.telegram.push(5, { text: "from telegram" });
  await notify(
    app.url,
    "main",
    messageEvent({
      contact: 5,
      traffic: "incoming",
      text: "from respond.io",
    }),
    world.respondio.signingKey,
  );

  await waitUntil(
    () => world.telegram.sent.length && world.respondio.sent.length,
  );
  expect(world.telegram.sent[0]?.text).toBe("Reply to from telegram");
  expect(world.respondio.sent[0]?.message.text).toBe(
    "Reply to from respond.io",
  );
  const contexts = world.llm
    .mainRequests()
    .map((r) => JSON.stringify(r.messages));
  expect(
    contexts.every(
      (c) => !(c.includes("from telegram") && c.includes("from respond.io")),
    ),
  ).toBe(true);
});
