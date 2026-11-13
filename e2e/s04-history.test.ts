import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import {
  minutesAgo,
  readChat,
  startApp,
  tempDir,
  waitUntil,
  writeChat,
} from "./support/app.ts";
import { contentText, type LlmRequest } from "./support/fake-openrouter.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const visible = (request: LlmRequest) =>
  request.messages
    .filter((m) => m.role !== "system")
    .map((m) => [m.role, contentText(m.content)]);

const migrated = `[${minutesAgo(60)}] customer {"ref":"old-1"}
  Do you sell beans?

[${minutesAgo(59)}] agent {"delivery":"sent"}
  Yes, we do.

[${minutesAgo(58)}] tool {"turn":"t0","name":"read_skill"}
  {"input":{"skill":"menu"},"output":"secret tool output"}

[${minutesAgo(57)}] note {"author":"agent"}
  Nudge
`;

test("§4 a restart keeps the record and the next turn uses it", async () => {
  world = await createWorld();
  const first = await world.start();
  world.telegram.push(42, { text: "First" });
  await waitUntil(() => world.telegram.sent.length);
  await first.stop();

  await world.start();
  world.telegram.push(42, { text: "Second" });
  await waitUntil(() => world.telegram.sent.length === 2);
  expect(visible(world.llm.mainRequests()[1]!)).toEqual([
    ["user", "First"],
    ["assistant", "Hello from the agent."],
    ["user", "Second"],
  ]);
});

test("§4 prepared folders are read without new work, and tool activity and notes stay out of context", async () => {
  world = await createWorld();
  await writeChat(world.dataDir, world.telegram.connectionId, "42", migrated);
  await world.start();
  await Bun.sleep(400);
  expect(world.llm.requests).toHaveLength(0);

  world.telegram.push(42, { text: "How much?" });
  await waitUntil(() => world.telegram.sent.length);
  expect(visible(world.llm.mainRequests()[0]!)).toEqual([
    ["user", "Do you sell beans?"],
    ["assistant", "Yes, we do."],
    ["user", "How much?"],
  ]);
});

test("§4 a damaged history is reported and kept while other conversations continue", async () => {
  world = await createWorld();
  const damaged = `${migrated}\n[not a header\n  lost?\n`;
  await writeChat(world.dataDir, world.telegram.connectionId, "1", damaged);
  const app = await world.start();
  const health = (await (await fetch(`${app.url}/health`)).json()) as {
    damagedConversations: number;
  };
  expect(health.damagedConversations).toBe(1);
  const report = await app.waitForLog("record.damaged");
  expect(report.conversations).toEqual([`${world.telegram.connectionId}/1`]);

  world.telegram.push(1, { text: "Still there?" });
  world.telegram.push(2, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length === 2);
  const text = await Bun.file(
    join(world.dataDir, world.telegram.connectionId, "1", "chat.txt"),
  ).text();
  expect(text).toContain("[not a header\n  lost?");
});

test("§4 storage that is not available prevents startup", async () => {
  world = await createWorld();
  const app = await startApp({
    ...world.baseEnv,
    ...world.telegramEnv,
    CONVERSATIONS_DIR: join(await tempDir(), "missing"),
  });
  expect(app.started).toBe(false);
  expect(await app.proc.exited).toBe(1);
});

test("§4 tool activity of an earlier turn never reaches the model", async () => {
  world = await createWorld();
  world.llm.respond((request) => {
    const calledTool = request.messages.some((m) => m.role === "tool");
    if (
      contentText(request.messages.at(-1)?.content) === "Price?" &&
      !calledTool
    ) {
      return { toolCalls: [{ name: "read_skill", args: { skill: "menu" } }] };
    }
    return { text: "A latte is RM 12." };
  });
  await world.start();
  world.telegram.push(42, { text: "Price?" });
  await waitUntil(() => world.telegram.sent.length);
  world.telegram.push(42, { text: "Thanks" });
  await waitUntil(() => world.telegram.sent.length === 2);

  const tool = (
    await readChat(world.dataDir, world.telegram.connectionId, "42")
  ).find((e) => e.tag === "tool");
  expect(tool?.text).toContain("Latte costs RM 12.");
  expect(
    world.llm
      .mainRequests()
      .at(-1)!
      .messages.map((m) => m.role),
  ).toEqual(["system", "user", "assistant", "user"]);
});

test("§6 a send that was on its way at restart stays uncertain and is not sent again", async () => {
  world = await createWorld();
  const inFlight = `[${minutesAgo(2)}] customer {"ref":"c1"}\n  Hi\n\n[${minutesAgo(1)}] agent {"turn":"t1","delivery":"sending"}\n  Maybe arrived\n`;
  await writeChat(world.dataDir, world.telegram.connectionId, "42", inFlight);
  const app = await world.start();
  await app.waitForLog("delivery.uncertain_after_restart");
  world.telegram.push(42, { text: "Hello?" });
  await waitUntil(() => world.telegram.sent.length);

  expect(world.telegram.sent.map((s) => s.text)).toEqual([
    "Hello from the agent.",
  ]);
  expect(visible(world.llm.mainRequests()[0]!)).toEqual([
    ["user", "Hi"],
    ["user", "Hello?"],
  ]);
  const agent = await waitUntil(async () => {
    const entries = (
      await readChat(world.dataDir, world.telegram.connectionId, "42")
    ).filter((e) => e.tag === "agent");
    return entries.length === 2 && entries.at(-1)!.meta.delivery !== "sending"
      ? entries
      : undefined;
  });
  expect(agent.map((e) => e.meta.delivery)).toEqual(["uncertain", "sent"]);
});
