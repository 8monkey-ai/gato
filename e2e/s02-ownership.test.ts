import { expect, test } from "bun:test";

import { waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import { messageText } from "./support/gateway.ts";
import { readChat, readState } from "./support/setup.ts";

const f = useTelegram();
const operatorChat = 999;

test("§2 new customer input interrupts the reply: unsent paced parts stop and the next turn sees delivered parts plus all new input", async () => {
  let call = 0;
  f.gateway.reply(() =>
    ++call === 1
      ? { text: "Part one\n\nPart two\n\nPart three" }
      : { text: "Fresh answer" },
  );
  await f.start({ DELIVERY_PAUSE: "1500ms" });
  f.telegram.customerMessage(1, { text: "First question" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  f.telegram.customerMessage(1, { text: "Second question" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  await Bun.sleep(1600);
  expect(f.telegram.sentTexts(1)).toEqual(["Part one", "Fresh answer"]);
  const second = f.gateway.requests[1]!.messages.filter(
    (m) => m.role !== "system",
  );
  expect(second.map((m) => [m.role, messageText(m)])).toEqual([
    ["user", "First question"],
    ["assistant", "Part one"],
    ["user", "Second question"],
  ]);
  const entries = await readChat(f.app.dataDir, "tg", "1");
  expect(entries.find((entry) => entry.type === "draft")?.text).toBe(
    "Part two\n\nPart three",
  );
  expect(
    entries
      .filter((entry) => entry.type === "outcome")
      .map((entry) => entry.text),
  ).toEqual([
    "Turn interrupted: New customer input arrived.",
    "Turn completed",
  ]);
});

test("§2 input during generation supersedes the unsent reply", async () => {
  let call = 0;
  f.gateway.reply(() =>
    ++call === 1
      ? { text: "slow ".repeat(40), chunkSize: 5, chunkDelayMs: 40 }
      : { text: "Answer to both" },
  );
  await f.start({ DELIVERY_BOUNDARY: "whole" });
  f.telegram.customerMessage(1, { text: "One" });
  await waitFor(() => f.gateway.requests.length === 1);
  await Bun.sleep(200);
  f.telegram.customerMessage(1, { text: "Two" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(f.telegram.sentTexts(1)).toEqual(["Answer to both"]);
  const entries = await readChat(f.app.dataDir, "tg", "1");
  expect(
    entries.some(
      (entry) => entry.text === "Turn superseded: New customer input arrived.",
    ),
  ).toBe(true);
});

test("§2 Telegram fallback: operators pause locally, messages are recorded only, and resume prompts a review", async () => {
  f.gateway.reply({ text: "Back to you" });
  await f.start({ CONNECTION_TG_OPERATOR_CHAT_ID: String(operatorChat) });
  f.telegram.customerMessage(operatorChat, { text: "/pause 5" });
  await waitFor(
    async () =>
      (await readState(f.app.dataDir, "tg", "5").catch(() => undefined))
        ?.assignee === "human",
  );
  f.telegram.customerMessage(5, { text: "Anyone there?" });
  await waitFor(async () =>
    (await readChat(f.app.dataDir, "tg", "5")).some(
      (entry) => entry.text === "Anyone there?",
    ),
  );
  await Bun.sleep(400);
  expect(f.gateway.requests).toHaveLength(0);
  f.telegram.customerMessage(operatorChat, { text: "/resume 5" });
  await waitFor(() => f.telegram.sentTexts(5).length === 1);
  expect(f.telegram.sentTexts(5)).toEqual(["Back to you"]);
});

test("§2 reassignment review without a pending customer request records an explanation and sends nothing", async () => {
  f.gateway.reply({ text: "Hello" });
  await f.start({ CONNECTION_TG_OPERATOR_CHAT_ID: String(operatorChat) });
  f.telegram.customerMessage(6, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(6).length === 1);
  f.telegram.customerMessage(operatorChat, { text: "/pause 6" });
  await Bun.sleep(300);
  f.telegram.customerMessage(operatorChat, { text: "/resume 6" });
  await waitFor(async () =>
    (await readChat(f.app.dataDir, "tg", "6")).some(
      (entry) =>
        entry.text === "Turn skipped: No customer request awaits an answer.",
    ),
  );
  f.telegram.customerMessage(operatorChat, { text: "/resume 6" });
  await Bun.sleep(300);
  expect(f.gateway.requests).toHaveLength(1);
  expect(f.telegram.sentTexts(6)).toHaveLength(1);
});

test("§2 closing stops answers and preserves the record; reopening reuses the same history", async () => {
  f.gateway.reply({ text: "Reply" });
  await f.start({ CONNECTION_TG_OPERATOR_CHAT_ID: String(operatorChat) });
  f.telegram.customerMessage(7, { text: "Before" });
  await waitFor(() => f.telegram.sentTexts(7).length === 1);
  f.telegram.customerMessage(operatorChat, { text: "/close 7" });
  await waitFor(
    async () => (await readState(f.app.dataDir, "tg", "7")).open === false,
  );
  f.telegram.customerMessage(7, { text: "While closed" });
  await Bun.sleep(400);
  expect(f.gateway.requests).toHaveLength(1);
  f.telegram.customerMessage(operatorChat, { text: "/open 7" });
  f.telegram.customerMessage(7, { text: "After" });
  await waitFor(() => f.telegram.sentTexts(7).length === 2);
  const texts = f.gateway.requests[1]!.messages.map(messageText);
  expect(texts).toContain("Before");
  expect(texts).toContain("While closed");
  expect(texts).toContain("After");
});

test("§2 conversations progress independently, one turn at a time each", async () => {
  f.gateway.reply(() => ({
    text: "slow reply",
    chunkSize: 2,
    chunkDelayMs: 50,
  }));
  await f.start();
  f.telegram.customerMessage(10, { text: "A" });
  f.telegram.customerMessage(11, { text: "B" });
  await waitFor(
    () =>
      f.telegram.sentTexts(10).length === 1 &&
      f.telegram.sentTexts(11).length === 1,
  );
  const [first, second] = f.telegram.calls.filter(
    (call) => call.method === "sendMessage",
  );
  expect(Math.abs(first!.at - second!.at)).toBeLessThan(400);
});

test("§8 local Telegram state survives restart: a paused conversation stays paused", async () => {
  f.gateway.reply({ text: "Should wait" });
  await f.start({ CONNECTION_TG_OPERATOR_CHAT_ID: String(operatorChat) });
  f.telegram.customerMessage(operatorChat, { text: "/pause 12" });
  await waitFor(
    async () =>
      (await readState(f.app.dataDir, "tg", "12").catch(() => undefined))
        ?.assignee === "human",
  );
  await f.restart();
  f.telegram.customerMessage(12, { text: "Hello after restart" });
  await waitFor(async () =>
    (await readChat(f.app.dataDir, "tg", "12")).some(
      (entry) => entry.text === "Hello after restart",
    ),
  );
  await Bun.sleep(400);
  expect(f.gateway.requests).toHaveLength(0);
});
