import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { readChat, skillFile, startApp, waitUntil } from "./support/app.ts";
import {
  contentText,
  type LlmRequest,
  systemText,
} from "./support/fake-openrouter.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const skills = {
  "skills/gcash/SKILL.md": skillFile(
    "gcash",
    "ph[Paying with GCash.]",
    "GCash steps.",
  ),
  "skills/Bad-Name/SKILL.md": skillFile("Bad-Name", "Broken.", "x"),
  "skills/menu/scripts/run.md": "do not read",
};

const readTool = (args: object) => (request: LlmRequest) =>
  request.messages.some((m) => m.role === "tool")
    ? { text: "Done." }
    : { toolCalls: [{ name: "read_skill", args }] };

const toolOutput = (request: LlmRequest) =>
  contentText(request.messages.find((m) => m.role === "tool")?.content);

test("§5 Malaysia deployments see only common and Malaysian content", async () => {
  world = await createWorld({ skills });
  world.llm.respond(readTool({ skill: "menu" }));
  const app = await world.start();
  world.telegram.push(42, { text: "Price?" });
  await waitUntil(() => world.telegram.sent.length);

  const [first, second] = world.llm.mainRequests();
  const system = systemText(first!);
  expect(system).toContain(
    "You help customers of Gato Coffee.\nPrices are in RM.",
  );
  expect(system).not.toContain("PHP");
  expect(system).toContain("- menu: The menu in RM. Use for prices.");
  expect(system).not.toContain("gcash");
  expect(toolOutput(second!)).toContain("Latte costs RM 12.");
  await app.waitForLog("skills.problems", (l) =>
    JSON.stringify(l).includes("Bad-Name"),
  );
});

test("§5 Philippine deployments see only common and Philippine content", async () => {
  world = await createWorld({ skills });
  world.llm.respond(readTool({ skill: "gcash" }));
  await world.start({ AGENT_COUNTRY: "PH" });
  world.telegram.push(42, { text: "Pay?" });
  await waitUntil(() => world.telegram.sent.length);

  const [first, second] = world.llm.mainRequests();
  expect(systemText(first!)).toContain("Prices are in PHP.");
  expect(systemText(first!)).toContain("- gcash: Paying with GCash.");
  expect(toolOutput(second!)).toContain("GCash steps.");
});

test("§5 reading a skill gives no access to other repository files", async () => {
  world = await createWorld({ skills });
  world.llm.respond(readTool({ skill: "menu", file: "scripts/run.md" }));
  await world.start();
  world.telegram.push(42, { text: "Hack" });
  await waitUntil(() => world.telegram.sent.length);

  expect(toolOutput(world.llm.mainRequests()[1]!)).not.toContain("do not read");
  const tool = (
    await readChat(world.dataDir, world.telegram.connectionId, "42")
  ).find((e) => e.tag === "tool");
  expect(tool?.meta.failed).toBe(true);
});

test("§5 a new turn uses the updated skills checkout", async () => {
  world = await createWorld();
  await world.start();
  world.telegram.push(42, { text: "One" });
  await waitUntil(() => world.telegram.sent.length);
  await Bun.write(join(world.skillsDir, "AGENTS.md"), "Updated rules.");
  world.telegram.push(42, { text: "Two" });
  await waitUntil(() => world.telegram.sent.length === 2);

  expect(systemText(world.llm.mainRequests()[1]!)).toContain("Updated rules.");
});

test("§5 a missing or unsupported country prevents startup", async () => {
  world = await createWorld();
  for (const country of ["", "SG"]) {
    const app = await startApp({
      ...world.baseEnv,
      ...world.telegramEnv,
      AGENT_COUNTRY: country,
    });
    expect(app.started).toBe(false);
    expect(app.startError).toContain("AGENT_COUNTRY");
  }
});

test("§5 malformed repository instructions fail visibly instead of answering", async () => {
  world = await createWorld();
  await world.start();
  await Bun.write(join(world.skillsDir, "AGENTS.md"), ":::my\nnever closed");
  world.telegram.push(42, { text: "Hi" });

  const chat = await waitUntil(async () => {
    const entries = await readChat(
      world.dataDir,
      world.telegram.connectionId,
      "42",
    );
    return entries.find((e) => e.tag === "turn");
  });
  expect(chat.meta.outcome).toBe("failed");
  expect(chat.text).toContain("AGENTS.md");
  expect(world.telegram.sent).toHaveLength(0);
});
