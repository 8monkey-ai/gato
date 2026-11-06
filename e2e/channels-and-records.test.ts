import { expect, test } from "bun:test";

import { messages, readChat } from "./support/app.ts";
import {
  agentUserId,
  messageEvent,
  postWebhook,
} from "./support/fake-respondio.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

test("§1 records: each Telegram chat keeps its own history and reply destination", async () => {
  const { telegram, gateway, dataDir } = await startHarness();
  gateway.script((request) => ({
    text: `Reply to ${JSON.stringify(request.messages.at(-1)?.content)}`,
  }));
  telegram.push(1, { text: "first chat" });
  telegram.push(2, { text: "second chat" });

  await until(() => telegram.sent().length === 2);
  const destinations = telegram.calls
    .filter((c) => c.method === "sendMessage")
    .map((c) => (c.body as { chat_id: unknown }).chat_id);
  expect(destinations.sort()).toEqual(["1", "2"]);
  expect(
    messages(await readChat(dataDir, "telegram", "1")).map((m) => m.text),
  ).toEqual(["first chat", 'Reply to "first chat"']);
  expect(
    messages(await readChat(dataDir, "telegram", "2")).map((m) => m.text),
  ).toEqual(["second chat", 'Reply to "second chat"']);
});

test("§1 records: the same contact id on two connections stays isolated", async () => {
  const { app, telegram, respondio, dataDir } = await startHarness({
    channels: "telegram,respondio",
  });
  telegram.push(9, { text: "from telegram" });
  await postWebhook(
    app.url,
    messageEvent({ contact: 9, text: "from respond.io" }),
  );

  await until(
    () => telegram.sent().length === 1 && respondio.sent().length === 1,
  );
  expect(messages(await readChat(dataDir, "telegram", "9"))[0]?.text).toBe(
    "from telegram",
  );
  expect(messages(await readChat(dataDir, "respondio", "9"))[0]?.text).toBe(
    "from respond.io",
  );
});

const outgoing = (
  source: string,
  text: string,
  timestamp: number,
  userId?: number,
) =>
  messageEvent({
    contact: 5,
    traffic: "outgoing",
    source,
    text,
    timestamp,
    userId,
  });

test("§1 classification: respond.io traffic is attributed and outgoing traffic never triggers a reply", async () => {
  const { app, gateway, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  const base = Date.now() - 60_000;
  const events = [
    messageEvent({ contact: 5, text: "hello", timestamp: base, assignee: 900 }),
    outgoing("workflow", "Auto: we got it", base + 1000),
    outgoing("user", "Hi, Sarah here", base + 2000, 900),
    outgoing("echo", "sent from phone", base + 3000),
    outgoing("user", "bot user text", base + 4000, agentUserId),
  ];
  for (const event of events) await postWebhook(app.url, event);

  await until(
    async () =>
      messages(await readChat(dataDir, "respondio", "5")).length === 5,
  );
  const record = messages(await readChat(dataDir, "respondio", "5"));
  expect(record.map((m) => [m.meta.role, m.meta.sender ?? null])).toEqual([
    ["customer", "Siti Aminah"],
    ["workflow", null],
    ["operator", "Sarah Lee"],
    ["operator", null],
    ["agent", null],
  ]);
  await Bun.sleep(300);
  expect(gateway.requests).toHaveLength(0);
  expect(respondio.sent()).toHaveLength(0);
});

test("§1 notifications: a repeated notification is stored once and answered once", async () => {
  const { app, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  const event = messageEvent({ contact: 6, text: "price?" });
  await postWebhook(app.url, event);
  await postWebhook(app.url, event);

  await until(() => respondio.sent().length === 1);
  await Bun.sleep(300);
  expect(respondio.sent()).toHaveLength(1);
  const record = messages(await readChat(dataDir, "respondio", "6"));
  expect(record.filter((m) => m.meta.role === "customer")).toHaveLength(1);
});

test("§1 notifications: the echo of an agent send reconciles to the original record", async () => {
  const { app, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  await postWebhook(app.url, messageEvent({ contact: 7, text: "hi" }));
  await until(() => respondio.sent().length === 1);
  const agent = await until(async () =>
    messages(await readChat(dataDir, "respondio", "7")).find(
      (m) => m.meta.delivery === "sent",
    ),
  );

  await postWebhook(
    app.url,
    messageEvent({
      contact: 7,
      traffic: "outgoing",
      source: "api",
      text: agent.text,
      messageId: Number(agent.meta.ref),
    }),
  );
  await Bun.sleep(200);
  const record = messages(await readChat(dataDir, "respondio", "7"));
  expect(record.filter((m) => m.meta.role === "agent")).toHaveLength(1);
});

test("§1 notifications: bad signatures are refused, malformed and irrelevant notifications run no agent", async () => {
  const { app, gateway } = await startHarness({ channels: "respondio" });
  const unsigned = await postWebhook(
    app.url,
    messageEvent({ contact: 8, text: "x" }),
    "wrong",
  );
  const malformed = await postWebhook(app.url, {
    event_type: "message.received",
    contact: {},
  });
  const irrelevant = await postWebhook(app.url, {
    event_type: "contact.tag.updated",
    contact: { id: 8 },
  });

  expect([unsigned.status, malformed.status, irrelevant.status]).toEqual([
    401, 200, 200,
  ]);
  await Bun.sleep(300);
  expect(gateway.requests).toHaveLength(0);
  expect(
    app.logs.some((line) => line.includes("respondio.webhook_malformed")),
  ).toBe(true);
});

test("§1 history order: a delayed message takes its original place", async () => {
  const { app, dataDir } = await startHarness({ channels: "respondio" });
  const now = Date.now();
  await postWebhook(
    app.url,
    messageEvent({
      contact: 11,
      text: "second",
      timestamp: now,
      assignee: 900,
    }),
  );
  await postWebhook(
    app.url,
    messageEvent({
      contact: 11,
      text: "first",
      timestamp: now - 5000,
      assignee: 900,
    }),
  );

  await until(
    async () =>
      messages(await readChat(dataDir, "respondio", "11")).length === 2,
  );
  expect(
    messages(await readChat(dataDir, "respondio", "11")).map((m) => m.text),
  ).toEqual(["first", "second"]);
});
