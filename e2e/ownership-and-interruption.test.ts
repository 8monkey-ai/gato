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

const paced = {
  DELIVERY_PACING: "typing",
  DELIVERY_TYPING_SECONDS_PER_WORD: "0.3",
};

function visible(request: ChatRequest) {
  return request.messages
    .filter((m) => m.role !== "system")
    .map(
      (m) =>
        `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    );
}

test("§2 ownership: a conversation assigned to a human is recorded without a reply", async () => {
  const { app, gateway, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  await postWebhook(
    app.url,
    messageEvent({ contact: 20, text: "hello?", assignee: 900 }),
  );

  await until(
    async () =>
      messages(await readChat(dataDir, "respondio", "20")).length === 1,
  );
  await Bun.sleep(300);
  expect(gateway.requests).toHaveLength(0);
  expect(respondio.sent()).toHaveLength(0);
});

test("§2 ownership: the agent answers when assigned to the agent user or to no one", async () => {
  const { app, respondio } = await startHarness({ channels: "respondio" });
  await postWebhook(
    app.url,
    messageEvent({ contact: 21, text: "a", assignee: agentUserId }),
  );
  await postWebhook(
    app.url,
    messageEvent({ contact: 22, text: "b", assignee: null }),
  );

  await until(() => respondio.sent().length === 2);
});

test("§2 ownership: after a return to the agent, the next customer message is answered and the return sends nothing", async () => {
  const { app, respondio, gateway } = await startHarness({
    channels: "respondio",
  });
  await postWebhook(
    app.url,
    messageEvent({ contact: 23, text: "while human", assignee: 900 }),
  );
  await Bun.sleep(300);
  expect(respondio.sent()).toHaveLength(0);

  await postWebhook(
    app.url,
    messageEvent({ contact: 23, text: "back to bot", assignee: agentUserId }),
  );
  await until(() => respondio.sent().length === 1);
  expect(visible(gateway.requests[0]!)).toEqual(
    ['user: "while human"', 'user: "back to bot"'].map((s) =>
      s.replaceAll('"', ""),
    ),
  );
});

test("§2 interruption: new customer input stops paced parts, and the next turn sees the delivered part and all new input", async () => {
  const { telegram, gateway, dataDir } = await startHarness({ env: paced });
  gateway.script((_, index) => ({
    text:
      index === 0
        ? "One.\n\nTwo two two two.\n\nThree three."
        : "Fresh answer.",
  }));
  telegram.push(30, { text: "question" });
  await until(() => telegram.sent().length === 1);
  telegram.push(30, { text: "wait, another thing" });

  await until(() => telegram.sent().length === 2);
  await Bun.sleep(1500);
  expect(telegram.sent()).toEqual(["One.", "Fresh answer."]);
  expect(visible(gateway.requests[1]!)).toEqual([
    "user: question",
    "assistant: One.",
    "user: wait, another thing",
  ]);
  const record = await readChat(dataDir, "telegram", "30");
  const turns = record
    .filter((e) => e.meta.type === "turn")
    .map((e) => [e.meta.status, e.meta.unsent ?? null]);
  expect(turns).toEqual([
    ["interrupted", "Two two two two.\n\nThree three."],
    ["completed", null],
  ]);
});

test("§2 interruption: a human taking ownership lets the current reply finish", async () => {
  const { app, respondio, gateway } = await startHarness({
    channels: "respondio",
    env: paced,
  });
  gateway.script(() => ({ text: "One.\n\nTwo two.\n\nThree." }));
  await postWebhook(app.url, messageEvent({ contact: 24, text: "hi" }));
  await until(() => respondio.sent().length === 1);
  respondio.assignees.set(24, 900);
  await postWebhook(
    app.url,
    messageEvent({
      contact: 24,
      traffic: "outgoing",
      source: "user",
      userId: 900,
      text: "I take over",
    }),
  );

  await until(() => respondio.sent().length === 3);
  expect(respondio.sent()).toEqual(["One.", "Two two.", "Three."]);
});
