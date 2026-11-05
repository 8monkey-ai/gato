import { expect, test } from "bun:test";

import { launch, logEvents, waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import { readChat } from "./support/setup.ts";

const f = useTelegram();

function sends(method = "sendMessage") {
  return f.telegram.calls.filter((call) => call.method === method);
}

test("§6 default delivery: paragraphs are separate messages in order, one final full stop removed, empty parts omitted", async () => {
  f.gateway.reply({ text: "First part.\n\n\n\nSecond part...\n\nThird part." });
  await f.start({ DELIVERY_PAUSE: "50ms" });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 3);
  expect(f.telegram.sentTexts(1)).toEqual([
    "First part",
    "Second part...",
    "Third part",
  ]);
  const [first, second] = sends();
  expect(second!.at - first!.at).toBeGreaterThanOrEqual(45);
});

test("§6 whole-reply boundary and original punctuation are configurable", async () => {
  f.gateway.reply({ text: "One.\n\nTwo." });
  await f.start({
    DELIVERY_BOUNDARY: "whole",
    DELIVERY_STRIP_FINAL_PERIOD: "false",
  });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  await Bun.sleep(300);
  expect(f.telegram.sentTexts(1)).toEqual(["One.\n\nTwo."]);
});

test("§6 streamed delivery sends completed parts before generation ends", async () => {
  f.gateway.reply({
    text: "Early part.\n\n" + "x".repeat(80),
    chunkSize: 4,
    chunkDelayMs: 30,
  });
  await f.start();
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  expect(sends()[0]!.at).toBeLessThan(f.gateway.streamEnds[0]!);
});

test("§6 complete-answer timing waits for the full answer", async () => {
  f.gateway.reply({
    text: "Early part.\n\n" + "x".repeat(80),
    chunkSize: 4,
    chunkDelayMs: 30,
  });
  await f.start({ DELIVERY_TIMING: "complete" });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  expect(sends()[0]!.at).toBeGreaterThanOrEqual(f.gateway.streamEnds[0]!);
});

test("§6 typing pacing: first message immediate, later ones about one second per word, with typing indicator", async () => {
  f.gateway.reply({ text: "Hello\n\none two three four" });
  await f.start({
    DELIVERY_PACING: "typing",
    DELIVERY_TYPING_PER_WORD: "100ms",
  });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  const [first, second] = sends();
  expect(second!.at - first!.at).toBeGreaterThanOrEqual(380);
  expect(
    f.telegram.calls.some((call) => call.method === "sendChatAction"),
  ).toBe(true);
});

test("§6 no added delay when pacing is none", async () => {
  f.gateway.reply({ text: "A\n\nB" });
  await f.start({ DELIVERY_PACING: "none", DELIVERY_PAUSE: "2s" });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2, 1500);
});

test("§6 a failed send stops remaining delivery and records which parts reached the customer", async () => {
  f.gateway.reply({ text: "One\n\nTwo\n\nThree" });
  await f.start();
  f.telegram.fail({
    method: "sendMessage",
    code: 400,
    description: "Bad Request: chat not found",
    skip: 1,
  });
  f.telegram.customerMessage(1, { text: "Hi" });
  const entries = await waitFor(async () => {
    const chat = await readChat(f.app.dataDir, "tg", "1");
    return chat.some((entry) => entry.type === "outcome") && chat;
  });
  await Bun.sleep(200);
  expect(f.telegram.sentTexts(1)).toEqual(["One"]);
  const agent = entries
    .filter((entry) => entry.role === "agent")
    .map((entry) => [entry.text, entry.delivery]);
  expect(agent).toEqual([
    ["One", "sent"],
    ["Two", "failed"],
  ]);
  expect(entries.find((entry) => entry.type === "draft")?.text).toBe("Three");
  expect(entries.find((entry) => entry.type === "outcome")?.text).toContain(
    "failed",
  );
});

test("§6 an uncertain send is logged and not resent", async () => {
  f.gateway.reply({ text: "One\n\nTwo" });
  await f.start();
  f.telegram.fail({ method: "sendMessage", drop: true });
  f.telegram.customerMessage(1, { text: "Hi" });
  const entries = await waitFor(async () => {
    const chat = await readChat(f.app.dataDir, "tg", "1");
    return chat.some((entry) => entry.type === "outcome") && chat;
  });
  await Bun.sleep(200);
  expect(sends()).toHaveLength(1);
  expect(
    entries
      .filter((entry) => entry.role === "agent")
      .map((entry) => entry.delivery),
  ).toEqual(["uncertain"]);
  expect(logEvents(f.app.logs, "delivery.uncertain")).toHaveLength(1);
});

test("§6 a rate-limited send is retried and delivered once", async () => {
  f.gateway.reply({ text: "Only" });
  await f.start();
  f.telegram.fail({
    method: "sendMessage",
    code: 429,
    description: "Too Many Requests",
    retryAfter: 1,
  });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1, 5000);
  const ok = await waitFor(async () =>
    (await readChat(f.app.dataDir, "tg", "1")).find(
      (entry) => entry.delivery === "sent",
    ),
  );
  expect(ok.text).toBe("Only");
});

test("§6 messages split further at the platform limit without losing content", async () => {
  const long = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
  f.gateway.reply({ text: long });
  await f.start({ DELIVERY_STRIP_FINAL_PERIOD: "false" });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  const texts = f.telegram.sentTexts(1);
  expect(texts.every((text) => text.length <= 4096)).toBe(true);
  expect(texts.join(" ")).toBe(long);
});

test("§6 approved company video links become video attachments and replace their surrounding text", async () => {
  f.gateway.reply({
    text: "Watch this: https://videos.example.com/intro.mp4\n\nSee https://other.example.com/page",
  });
  await f.start({ VIDEO_LINK_PREFIXES: "https://videos.example.com/" });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => sends("sendVideo").length === 1 && sends().length === 1);
  expect(sends("sendVideo")[0]!.body.video).toBe(
    "https://videos.example.com/intro.mp4",
  );
  expect(f.telegram.sentTexts(1)).toEqual([
    "See https://other.example.com/page",
  ]);
});

test("§6 surrounding text can be sent separately, and video links can stay text", async () => {
  f.gateway.reply({ text: "Watch this: https://videos.example.com/intro.mp4" });
  await f.start({
    VIDEO_LINK_PREFIXES: "https://videos.example.com/",
    VIDEO_SURROUNDING_TEXT: "separate",
  });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => sends("sendVideo").length === 1);
  expect(f.telegram.sentTexts(1)).toEqual(["Watch this:"]);
  await f.restart({ VIDEO_LINKS_AS: "text" });
  f.telegram.customerMessage(1, { text: "Again" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  expect(f.telegram.sentTexts(1)[1]).toBe(
    "Watch this: https://videos.example.com/intro.mp4",
  );
});

test("§6 invalid delivery settings are rejected with an actionable explanation", async () => {
  const { child, logs } = launch({
    COUNTRY: "MY",
    MODEL: "m",
    OPENROUTER_API_KEY: "k",
    DATA_DIR: "/tmp/gato-invalid",
    CONNECTIONS: "tg",
    CONNECTION_TG_TYPE: "telegram",
    CONNECTION_TG_BOT_TOKEN: "1:x",
    DELIVERY_PACING: "fast",
  });
  expect(await child.exited).toBe(1);
  await Bun.sleep(50);
  expect(logs.join("\n")).toContain(
    'Invalid DELIVERY_PACING=\\"fast\\". Use one of: fixed, typing, none.',
  );
});
