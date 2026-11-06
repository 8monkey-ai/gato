import { expect, test } from "bun:test";

import { messages, readChat } from "./support/app.ts";
import type { ChatRequest } from "./support/fake-gateway.ts";
import {
  agentUserId,
  messageEvent,
  postWebhook,
} from "./support/fake-respondio.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

const roles = (request: ChatRequest | undefined) =>
  request?.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${JSON.stringify(m.content)}`);

test("journey 1: shared service, attribution, and no reply loops", async () => {
  const { app, gateway, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  const post = (options: Omit<Parameters<typeof messageEvent>[0], "contact">) =>
    postWebhook(app.url, messageEvent({ contact: 150, ...options }));
  gateway.script(() => ({ text: "Let me check." }));
  await post({ text: "Where is my order?" });
  await until(() => respondio.sent().length === 1);
  const record = messages(await readChat(dataDir, "respondio", "150"));
  const agentRef = Number(
    record.find((m) => m.meta.role === "agent")?.meta.ref,
  );
  await post({
    traffic: "outgoing",
    source: "api",
    text: "Let me check.",
    messageId: agentRef,
  });
  await post({
    traffic: "outgoing",
    source: "user",
    userId: 900,
    text: "Sarah here, it ships today",
  });
  await post({ text: "thanks Sarah", assignee: 900 });
  await Bun.sleep(300);
  expect(respondio.sent()).toHaveLength(1);

  await post({ text: "one more question", assignee: agentUserId });
  await until(() => respondio.sent().length === 2);
  expect(roles(gateway.requests[1])).toEqual([
    'user: "Where is my order?"',
    'assistant: "Let me check."',
    'assistant: "[Human colleague Sarah Lee] Sarah here, it ships today"',
    'user: "thanks Sarah"',
    'user: "one more question"',
  ]);
});

test("journey 2: a send with an uncertain outcome that the channel later confirms joins the next context once", async () => {
  const { app, gateway, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  gateway.script((_, index) => ({
    text: index === 0 ? "First answer." : "Second answer.",
  }));
  respondio.failSend = 502;
  await postWebhook(app.url, messageEvent({ contact: 151, text: "hi" }));
  await until(async () =>
    messages(await readChat(dataDir, "respondio", "151")).some(
      (m) => m.meta.delivery === "uncertain",
    ),
  );

  await postWebhook(
    app.url,
    messageEvent({
      contact: 151,
      traffic: "outgoing",
      source: "api",
      text: "First answer.",
      messageId: 777,
    }),
  );
  await until(async () =>
    messages(await readChat(dataDir, "respondio", "151")).some(
      (m) => m.meta.ref === "777",
    ),
  );
  await postWebhook(app.url, messageEvent({ contact: 151, text: "and?" }));
  await until(() => respondio.sent().length === 2);

  expect(respondio.sent()).toEqual(["First answer.", "Second answer."]);
  expect(roles(gateway.requests[1])).toEqual([
    'user: "hi"',
    'assistant: "First answer."',
    'user: "and?"',
  ]);
  const agent = messages(await readChat(dataDir, "respondio", "151")).filter(
    (m) => m.text === "First answer.",
  );
  expect(agent.map((m) => m.meta.delivery)).toEqual(["sent"]);
});

test("journey 7: a configuration change after a restart never repeats committed actions", async () => {
  const { app, telegram, start } = await startHarness();
  telegram.push(152, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  await app.stop();
  await start({
    DELIVERY_MESSAGE_BOUNDARY: "\\n",
    NUDGE_ENABLED: "true",
    NUDGE_CHECK_INTERVAL_SECONDS: "0.2",
  });
  await Bun.sleep(800);
  expect(telegram.sent()).toEqual(["Hello."]);
});

test("journey 8: respond.io and Telegram work at the same time with isolated tools and handoff", async () => {
  const { app, gateway, telegram, respondio } = await startHarness({
    channels: "telegram,respondio",
  });
  telegram.push(153, { text: "telegram hi" });
  await postWebhook(
    app.url,
    messageEvent({ contact: 153, text: "respondio hi" }),
  );
  await until(
    () => telegram.sent().length === 1 && respondio.sent().length === 1,
  );

  const toolsFor = (text: string) =>
    gateway.requests
      .find((r) => JSON.stringify(r.messages).includes(text))
      ?.tools?.map((t) => t.function.name);
  expect(toolsFor("telegram hi")).toEqual(["read_skill"]);
  expect(toolsFor("respondio hi")).toEqual(["read_skill", "handoff"]);
});
