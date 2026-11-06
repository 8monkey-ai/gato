import { expect, test } from "bun:test";

import { messages, readChat, type RecordEntry } from "./support/app.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

test("§6 delivery: each paragraph is one message, in order, sent once", async () => {
  const { telegram, gateway, dataDir } = await startHarness();
  gateway.script(() => ({
    text: "Hello Ali!\n\nOur price is RM 10.\n\n\n\nAnything else?",
  }));
  telegram.push(42, { text: "How much?" });

  await until(() => telegram.sent().length === 3);
  expect(telegram.sent()).toEqual([
    "Hello Ali!",
    "Our price is RM 10.",
    "Anything else?",
  ]);

  const record = messages(await readChat(dataDir, "telegram", "42"));
  expect(
    record.map((m) => [m.meta.role, m.text, m.meta.delivery ?? null]),
  ).toEqual([
    ["customer", "How much?", null],
    ["agent", "Hello Ali!", "sent"],
    ["agent", "Our price is RM 10.", "sent"],
    ["agent", "Anything else?", "sent"],
  ]);
});

/** Waits for the first finished turn, then lets the follow-up records settle. */
const turnOf = async (dataDir: string, chat: string) => {
  const finished = (e: RecordEntry) =>
    e.meta.type === "turn" && e.meta.status !== "running";
  await until(async () =>
    (await readChat(dataDir, "telegram", chat)).some(finished),
  );
  await Bun.sleep(150);
  const entries = await readChat(dataDir, "telegram", chat);
  return { turn: entries.find(finished) as RecordEntry, entries };
};

test("§6 delivery: a configured boundary splits the answer and parts keep their punctuation", async () => {
  const { telegram, gateway } = await startHarness({
    env: { DELIVERY_MESSAGE_BOUNDARY: "\\n" },
  });
  gateway.script(() => ({ text: "Line one!\nLine two?\n" }));
  telegram.push(90, { text: "hi" });
  await until(() => telegram.sent().length === 2);
  expect(telegram.sent()).toEqual(["Line one!", "Line two?"]);
});

test("§6 pacing: the first message goes at once, later ones wait about one pace per word with a typing indicator", async () => {
  const { telegram, gateway } = await startHarness({
    env: { DELIVERY_PACING: "typing", DELIVERY_TYPING_SECONDS_PER_WORD: "0.2" },
  });
  gateway.script(() => ({ text: "Hi.\n\none two three four five" }));
  telegram.push(91, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  const first = Date.now();
  await until(() => telegram.sent().length === 2);
  expect(Date.now() - first).toBeGreaterThanOrEqual(800);
  expect(telegram.calls.some((c) => c.method === "sendChatAction")).toBe(true);
});

test("§6 video links: approved links become videos that replace the text; other links stay text", async () => {
  const { telegram, gateway } = await startHarness({
    env: { DELIVERY_APPROVED_VIDEO_URLS: "https://videos.example.com/" },
  });
  gateway.script(() => ({
    text: "Watch https://videos.example.com/a.mp4 now.\n\nRead https://other.example.com/b.mp4.",
  }));
  telegram.push(92, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  const videos = telegram.calls
    .filter((c) => c.method === "sendVideo")
    .map((c) => (c.body as { video: unknown }).video);
  expect(videos).toEqual(["https://videos.example.com/a.mp4"]);
  expect(telegram.sent()).toEqual(["Read https://other.example.com/b.mp4."]);
});

test("§6 video links: the separate option keeps the surrounding text in order, and the text option keeps links", async () => {
  const text = "Watch https://videos.example.com/a.mp4 now.";
  const separate = await startHarness({
    env: {
      DELIVERY_APPROVED_VIDEO_URLS: "https://videos.example.com/",
      DELIVERY_VIDEO_LINK_TEXT: "separate",
    },
  });
  separate.gateway.script(() => ({ text }));
  separate.telegram.push(93, { text: "hi" });
  await until(() => separate.telegram.sent().length === 2);
  expect(
    separate.telegram.calls
      .filter(
        (c) => c.method.startsWith("send") && c.method !== "sendChatAction",
      )
      .map((c) => c.method),
  ).toEqual(["sendMessage", "sendVideo", "sendMessage"]);
  expect(separate.telegram.sent()).toEqual(["Watch", "now."]);

  const links = await startHarness({
    env: {
      DELIVERY_APPROVED_VIDEO_URLS: "https://videos.example.com/",
      DELIVERY_VIDEO_LINKS: "text",
    },
  });
  links.gateway.script(() => ({ text }));
  links.telegram.push(94, { text: "hi" });
  await until(() => links.telegram.sent().length === 1);
  expect(links.telegram.sent()).toEqual([text]);
});

test("§6 limits: a part longer than the channel limit is split without losing text", async () => {
  const { telegram, gateway } = await startHarness();
  const long = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
  gateway.script(() => ({ text: long }));
  telegram.push(95, { text: "hi" });
  await until(() => telegram.sent().length === 2);
  expect(telegram.sent().every((t) => t.length <= 4096)).toBe(true);
  expect(telegram.sent().join(" ")).toBe(long);
});

test("§6 skip: a deliberate skip sends nothing and keeps its explanation private", async () => {
  const { telegram, gateway, dataDir } = await startHarness();
  gateway.script(() => ({ text: "NO_REPLY: the customer only said thanks" }));
  telegram.push(96, { text: "thanks" });
  const { turn, entries } = await turnOf(dataDir, "96");
  expect(turn.meta.status).toBe("skipped");
  expect(entries.find((e) => e.meta.kind === "skip")?.text).toBe(
    "the customer only said thanks",
  );
  expect(entries.some((e) => e.meta.kind === "error")).toBe(false);
  expect(telegram.sent()).toHaveLength(0);
});

test("§6 failure: a failed send stops the remaining parts and records what reached the customer", async () => {
  const { telegram, gateway, dataDir } = await startHarness();
  gateway.script(() => ({ text: "One.\n\nTwo.\n\nThree." }));
  telegram.fail("sendMessage", 400, 1);
  telegram.push(97, { text: "hi" });
  const { turn, entries } = await turnOf(dataDir, "97");

  expect(turn.meta).toMatchObject({ status: "failed", unsent: "Three." });
  const agent = messages(entries).filter((m) => m.meta.role === "agent");
  expect(agent.map((m) => [m.text, m.meta.delivery])).toEqual([
    ["One.", "sent"],
    ["Two.", "failed"],
  ]);
  await Bun.sleep(200);
  expect(telegram.calls.filter((c) => c.method === "sendMessage")).toHaveLength(
    2,
  );
  expect(
    (await readChat(dataDir, "telegram", "97")).some(
      (e) => e.meta.kind === "error",
    ),
  ).toBe(true);
});

test("§6 uncertain sends: an uncertain outcome is logged and never sent again", async () => {
  const { telegram, gateway, dataDir, app } = await startHarness();
  gateway.script(() => ({ text: "One.\n\nTwo." }));
  telegram.fail("sendMessage", 502);
  telegram.push(98, { text: "hi" });
  const { turn, entries } = await turnOf(dataDir, "98");
  expect(turn.meta.status).toBe("failed");
  expect(
    messages(entries)
      .filter((m) => m.meta.role === "agent")
      .map((m) => m.meta.delivery),
  ).toEqual(["uncertain"]);
  expect(entries.some((e) => e.meta.kind === "error")).toBe(false);
  expect(telegram.calls.filter((c) => c.method === "sendMessage")).toHaveLength(
    1,
  );
  expect(
    app.logs.some(
      (l) => l.includes("delivery.stopped") && l.includes("uncertain"),
    ),
  ).toBe(true);
});

test("§6 retries: a send that the platform refused for rate limits is retried once accepted", async () => {
  const { telegram, gateway } = await startHarness();
  gateway.script(() => ({ text: "Only once." }));
  telegram.fail("sendMessage", 429);
  telegram.push(99, { text: "hi" });
  await until(() => telegram.sent().length === 2);
  await Bun.sleep(300);
  expect(telegram.sent()).toEqual(["Only once.", "Only once."]);
  expect(telegram.calls.filter((c) => c.method === "sendMessage")).toHaveLength(
    2,
  );
});

test("§6 limits: reaching the model-call limit stops the turn and records the outcome", async () => {
  const { telegram, gateway, dataDir } = await startHarness({
    env: { TURN_MAX_MODEL_CALLS: "2" },
  });
  gateway.script(() => ({
    toolCalls: [
      { name: "read_skill", args: { path: "skills/pricing/SKILL.md" } },
    ],
  }));
  telegram.push(100, { text: "hi" });
  const { turn, entries } = await turnOf(dataDir, "100");
  expect(turn.meta.status).toBe("failed");
  expect(String(turn.meta.reason)).toContain("limit of 2 model calls");
  expect(gateway.requests).toHaveLength(2);
  expect(entries.some((e) => e.meta.kind === "error")).toBe(true);
});

test("§6 limits: reaching the response time limit stops the turn as timed out", async () => {
  const { telegram, gateway, dataDir } = await startHarness({
    env: { TURN_TIMEOUT_SECONDS: "1" },
  });
  gateway.script(() => ({
    text: "very slow answer that never ends in time",
    chunkDelayMs: 400,
  }));
  telegram.push(101, { text: "hi" });
  const { turn } = await turnOf(dataDir, "101");
  expect(turn.meta.status).toBe("timed-out");
  expect(telegram.sent()).toHaveLength(0);
});
