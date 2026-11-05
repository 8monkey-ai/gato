import { afterEach, beforeEach, expect, test } from "bun:test";

import type { RunningApp } from "./support/app.ts";
import { startApp, waitFor } from "./support/app.ts";
import type { FakeGateway } from "./support/gateway.ts";
import { messageText, startFakeGateway } from "./support/gateway.ts";
import { readChat, telegramEnv } from "./support/setup.ts";
import type { FakeTelegram } from "./support/telegram.ts";
import { startFakeTelegram } from "./support/telegram.ts";

let gateway: FakeGateway;
let telegram: FakeTelegram;
let app: RunningApp | undefined;

beforeEach(() => {
  gateway = startFakeGateway();
  telegram = startFakeTelegram();
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  await gateway.stop();
  await telegram.stop();
});

test("§1 Telegram: a customer message gets a reply and both are recorded with attribution", async () => {
  gateway.reply({ text: "Hi Ana, how can I help?" });
  app = await startApp(telegramEnv(gateway, telegram));
  telegram.customerMessage(7, { text: "Hello there" });

  await waitFor(() => telegram.sentTexts(7).length === 1, 8000, "reply");
  expect(telegram.sentTexts(7)).toEqual(["Hi Ana, how can I help?"]);
  const lastUser = gateway.requests[0]!.messages.at(-1)!;
  expect(lastUser.role).toBe("user");
  expect(messageText(lastUser)).toBe("Hello there");

  const chat = await waitFor(async () => {
    const entries = await readChat(app!.dataDir, "tg", "7");
    return (
      entries.some(
        (entry) => entry.role === "agent" && entry.delivery === "sent",
      ) && entries
    );
  });
  const messages = chat.filter((entry) => entry.kind === "message");
  expect(
    messages.map((entry) => [entry.role, entry.text, entry.delivery]),
  ).toEqual([
    ["customer", "Hello there", undefined],
    ["agent", "Hi Ana, how can I help?", "sent"],
  ]);
});

test("§1 repeated notifications do not duplicate messages or replies", async () => {
  gateway.reply({ text: "Hello" });
  app = await startApp(telegramEnv(gateway, telegram));
  const update = telegram.customerMessage(8, { text: "Hi" });
  await waitFor(() => telegram.sentTexts(8).length === 1);
  telegram.repeat(update);
  await Bun.sleep(600);
  const entries = await readChat(app.dataDir, "tg", "8");
  expect(entries.filter((entry) => entry.role === "customer")).toHaveLength(1);
  expect(telegram.sentTexts(8)).toHaveLength(1);
  expect(gateway.requests).toHaveLength(1);
});

test("§1 outgoing agent messages do not trigger another answer", async () => {
  gateway.reply({ text: "One answer" });
  app = await startApp(telegramEnv(gateway, telegram));
  telegram.customerMessage(9, { text: "Question" });
  await waitFor(() => telegram.sentTexts(9).length === 1);
  await Bun.sleep(600);
  expect(gateway.requests).toHaveLength(1);
});
