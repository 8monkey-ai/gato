import { afterEach, expect, test } from "bun:test";

import { readChat, startApp, waitUntil } from "./support/app.ts";
import { systemText } from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

async function reply(
  text: string,
  env: Record<string, string> = {},
  chunkDelayMs = 0,
  setup = () => {},
) {
  world = await createWorld();
  world.llm.respond(() => ({ text, chunkDelayMs }));
  await world.start(env);
  setup();
  const pushedAt = Date.now();
  world.telegram.push(42, { text: "Hi" });
  return pushedAt;
}

const turnEntry = () =>
  waitUntil(async () =>
    (await readChat(world.dataDir, world.telegram.connectionId, "42")).find(
      (e) => e.tag === "turn",
    ),
  );
const sentTexts = () =>
  world.telegram.sent.map((s) => s.text ?? `${s.method}:${s.media}`);

test("§6 each paragraph is sent as its own message", async () => {
  await reply("Hello!\n\nHow can I help?\n\n");
  await turnEntry();
  expect(sentTexts()).toEqual(["Hello!", "How can I help?"]);
});

test("§6 a configured boundary splits the reply", async () => {
  await reply("One|||Two\n\nstill two", { DELIVERY_MESSAGE_BOUNDARY: "|||" });
  await turnEntry();
  expect(sentTexts()).toEqual(["One", "Two\n\nstill two"]);
  expect(systemText(world.llm.mainRequests()[0]!)).toContain(
    "To start a new chat message, write `|||`.",
  );
});

test("§6 the default boundary is named to the agent as a blank line", async () => {
  await reply("Hi");
  await turnEntry();
  expect(systemText(world.llm.mainRequests()[0]!)).toContain(
    "To start a new chat message, write `\\n\\n`.",
  );
});

test("§6 media URLs are sent as attachments between the text around them", async () => {
  await reply(
    "Our menu https://cdn.test/menu.pdf and a photo: https://cdn.test/latte.jpg Enjoy!",
  );
  await turnEntry();
  expect(sentTexts()).toEqual([
    "Our menu",
    "sendDocument:https://cdn.test/menu.pdf",
    "and a photo:",
    "sendPhoto:https://cdn.test/latte.jpg",
    "Enjoy!",
  ]);
});

test("§6 text longer than the platform limit is split without losing content", async () => {
  const long = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
  await reply(long);
  await turnEntry();
  expect(world.telegram.sent.length).toBe(2);
  expect(sentTexts().join(" ")).toBe(long);
});

test("§6 the first message waits its typing time from the turn start, with a typing indicator", async () => {
  const pushedAt = await reply("one two three four five\n\nsix", {
    DELIVERY_PACING: "typing",
    DELIVERY_TYPING_SECONDS_PER_WORD: "0.2",
  });
  await waitUntil(() => world.telegram.sent.length === 2, 4000);
  const [first, second] = world.telegram.sent;
  expect(first!.at - pushedAt).toBeGreaterThanOrEqual(1000);
  expect(second!.at - first!.at).toBeGreaterThanOrEqual(200);
  expect(world.telegram.actions.length).toBeGreaterThan(0);
});

test("§6 generation time counts toward the typing time", async () => {
  const pushedAt = await reply(
    "one two three four five",
    { DELIVERY_PACING: "typing", DELIVERY_TYPING_SECONDS_PER_WORD: "0.2" },
    250,
  );
  await waitUntil(() => world.telegram.sent.length, 4000);
  expect(world.telegram.sent[0]!.at - pushedAt).toBeLessThan(1900);
});

test("§6 invalid delivery settings are rejected with an explanation", async () => {
  world = await createWorld();
  const app = await startApp({
    ...world.baseEnv,
    ...world.telegramEnv,
    DELIVERY_PACING: "fast",
  });
  expect(app.started).toBe(false);
  expect(app.startError).toContain("DELIVERY_PACING");
});

test("§6 a refused part stops the remaining delivery and the record shows what arrived", async () => {
  await reply("One.\n\nTwo.\n\nThree.", {}, 0, () =>
    world.telegram.failNext("sendMessage", 403, 1),
  );
  await turnEntry();
  const chat = await readChat(world.dataDir, world.telegram.connectionId, "42");
  expect(
    chat.filter((e) => e.tag === "agent").map((e) => [e.text, e.meta.delivery]),
  ).toEqual([
    ["One.", "sent"],
    ["Two.", "failed"],
    ["Three.", "unsent"],
  ]);
  expect((await turnEntry()).meta.outcome).toBe("failed");
});

test("§6 a refused attachment is sent as its URL instead", async () => {
  await reply("https://cdn.test/latte.jpg", {}, 0, () =>
    world.telegram.failNext("sendPhoto", 400),
  );
  await turnEntry();
  expect(sentTexts()).toEqual(["https://cdn.test/latte.jpg"]);
});

test("§6 a rate-limited send is retried and delivered once", async () => {
  await reply("Hello.", {}, 0, () =>
    world.telegram.failNext("sendMessage", 429),
  );
  await turnEntry();
  expect(sentTexts()).toEqual(["Hello."]);
});

test("§6 an uncertain send is logged and never sent again", async () => {
  world = await createWorld();
  world.llm.respond(() => ({ text: "One.\n\nTwo." }));
  const app = await world.start({}, "respondio");
  world.respondio.failNextSend(502);
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Hi" }),
    world.respondio.signingKey,
  );

  await app.waitForLog("turn.ended");
  const agent = (await readChat(world.dataDir, "respondio-main", "5")).filter(
    (e) => e.tag === "agent",
  );
  expect(agent.map((e) => e.meta.delivery)).toEqual(["uncertain", "unsent"]);
  expect(world.respondio.sent).toHaveLength(0);
  expect(world.respondio.tags).toHaveLength(0);
  await app.waitForLog(
    "delivery.send_failed",
    (l) => l.outcome === "uncertain",
  );
});
