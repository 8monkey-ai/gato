import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  minutesAgo,
  readChat,
  tempDir,
  waitUntil,
  writeChat,
} from "./support/app.ts";
import {
  lastUserText,
  type LlmRequest,
  systemText,
} from "./support/fake-openrouter.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const promptNames = [
  "conversation",
  "summary",
  "prepare-image",
  "prepare-document",
  "prepare-audio",
  "nudge",
  "continue",
  "tool-read-skill",
  "tool-handoff",
];

async function writePrompts(files: Record<string, string> = {}) {
  const dir = await tempDir("gato-prompts-");
  const all = {
    ...Object.fromEntries(
      promptNames.map((name) => [`${name}.md`, `Mounted ${name}.`]),
    ),
    "conversation.md": "Mounted rules for {{channel}}.\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all))
    await Bun.write(join(dir, path), text);
  return dir;
}

const toolDescription = (request: LlmRequest, name: string) =>
  request.tools?.find((t) => t.function.name === name)?.function.description;

async function turnEntry(contact: string) {
  return waitUntil(async () => {
    const entries = await readChat(
      world.dataDir,
      world.telegram.connectionId,
      contact,
    );
    return entries.find((e) => e.tag === "turn");
  });
}

test("§5 a mounted prompts folder replaces the built-in prompts", async () => {
  world = await createWorld();
  const days = 5 * 24 * 60;
  await writeChat(
    world.dataDir,
    world.telegram.connectionId,
    "42",
    `[${minutesAgo(days)}] customer {"ref":"a"}\n  Hello\n\n[${minutesAgo(days - 1)}] agent {"delivery":"sent"}\n  Hi.\n`,
  );
  world.telegram.files.set("p", new Uint8Array([1, 2, 3]));
  await world.start({
    PROMPTS_DIR: await writePrompts(),
    IMAGE_PREPARATION_MODEL: "test/vision",
    NUDGES_ENABLED: "true",
    NUDGES_CHECK_INTERVAL_SECONDS: "0.2",
    NUDGES_MILESTONES_MINUTES: "0.02",
  });
  world.telegram.push(42, {
    photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
  });
  await waitUntil(() => world.telegram.sent.length === 2, 4000);

  const call = (type: string) =>
    world.llm.requests.find((r) => r.metadata?.call_type === type)!;
  expect(systemText(call("summary"))).toBe("Mounted summary.");
  expect(systemText(call("preparation"))).toBe("Mounted prepare-image.");
  expect(lastUserText(call("nudge"))).toBe("Mounted nudge.");
  const request = call("message");
  expect(systemText(request)).toBe("Mounted rules for Telegram.");
  expect(toolDescription(request, "read_skill")).toBe(
    "Mounted tool-read-skill.",
  );
});

test("§5 without a mounted prompts folder the built-in prompts apply", async () => {
  world = await createWorld();
  await world.start();
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length);

  const [request] = world.llm.mainRequests();
  expect(systemText(request!)).toStartWith(
    "You are a customer service agent. You write to one customer through Telegram.",
  );
  expect(toolDescription(request!, "read_skill")).toStartWith(
    "Read a skill or one of its reference files.",
  );
});

test("§5 a changed prompt file applies to the next turn", async () => {
  world = await createWorld();
  const dir = await writePrompts();
  await world.start({ PROMPTS_DIR: dir });
  world.telegram.push(42, { text: "One" });
  await waitUntil(() => world.telegram.sent.length);
  await Bun.write(join(dir, "conversation.md"), "Updated rules.");
  world.telegram.push(42, { text: "Two" });
  await waitUntil(() => world.telegram.sent.length === 2);

  expect(systemText(world.llm.mainRequests()[1]!)).toBe("Updated rules.");
});

test("§5 a turn keeps the prompts it started with", async () => {
  world = await createWorld();
  const dir = await writePrompts();
  world.llm.respond(async (request) => {
    if (request.messages.some((m) => m.role === "tool")) return { text: "Ok." };
    await Bun.write(join(dir, "conversation.md"), "Updated rules.");
    await Bun.write(join(dir, "tool-read-skill.md"), "Updated tool.");
    return { toolCalls: [{ name: "read_skill", args: { skill: "menu" } }] };
  });
  await world.start({ PROMPTS_DIR: dir });
  world.telegram.push(42, { text: "Price?" });
  await waitUntil(() => world.telegram.sent.length);

  const second = world.llm.mainRequests()[1]!;
  expect(systemText(second)).toBe("Mounted rules for Telegram.");
  expect(toolDescription(second, "read_skill")).toBe(
    "Mounted tool-read-skill.",
  );
});

test("§5 a missing or empty prompt file prevents startup and names the file", async () => {
  world = await createWorld();
  const missing = await writePrompts();
  await rm(join(missing, "nudge.md"));
  const empty = await writePrompts({ "summary.md": " \n" });

  const first = await world.start({ PROMPTS_DIR: missing });
  expect(first.started).toBe(false);
  expect(first.startError).toContain(join(missing, "nudge.md"));
  const second = await world.start({ PROMPTS_DIR: empty });
  expect(second.started).toBe(false);
  expect(second.startError).toContain(join(empty, "summary.md"));
});

test("§5 a prompt that becomes missing or empty fails the turn visibly", async () => {
  world = await createWorld();
  const dir = await writePrompts();
  await world.start({ PROMPTS_DIR: dir });
  await rm(join(dir, "conversation.md"));
  world.telegram.push(42, { text: "Hi" });
  const missing = await turnEntry("42");
  await Bun.write(join(dir, "conversation.md"), "Rules.");
  await Bun.write(join(dir, "continue.md"), "");
  world.telegram.push(43, { text: "Hi" });
  const empty = await turnEntry("43");

  expect(missing.meta.outcome).toBe("failed");
  expect(missing.text).toContain(join(dir, "conversation.md"));
  expect(empty.meta.outcome).toBe("failed");
  expect(empty.text).toContain(join(dir, "continue.md"));
  expect(world.telegram.sent).toHaveLength(0);
});

test("§5 files in a mounted prompts folder that are not prompts are reported", async () => {
  world = await createWorld();
  const dir = await writePrompts({
    "notes.txt": "x",
    "old/summary.md": "x",
    ".git/HEAD": "x",
    "..data": "x",
    "..2024_01_01/summary.md": "x",
  });
  const app = await world.start({ PROMPTS_DIR: dir });

  expect(app.started).toBe(true);
  const line = await app.waitForLog("prompts.problems");
  expect((line.problems as string[]).toSorted()).toEqual([
    "notes.txt is not a prompt file and is not used",
    "old/summary.md is not a prompt file and is not used",
  ]);
});
