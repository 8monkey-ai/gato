import { afterEach, expect, test } from "bun:test";
import { cp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

import {
  type App,
  minutesAgo,
  readChat,
  startApp,
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
      promptNames.map((name) => [`${name}.txt`, `Mounted ${name}.`]),
    ),
    "conversation.txt": "Mounted rules for {{channel}}.\n",
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
  const fiveDays = 5 * 24 * 60;
  await writeChat(
    world.dataDir,
    world.telegram.connectionId,
    "42",
    `[${minutesAgo(fiveDays)}] customer {"ref":"a"}\n  Hello\n\n[${minutesAgo(fiveDays - 1)}] agent {"delivery":"sent"}\n  Hi.\n`,
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

// The source copy is deleted before the start, so a binary that reads prompts from the source tree fails.
async function buildFromCopy(buildDir: string) {
  const repoRoot = join(import.meta.dir, "..");
  const source = join(buildDir, "source");
  for (const entry of ["package.json", "tsconfig.json", "src", "prompts"])
    await cp(join(repoRoot, entry), join(source, entry), { recursive: true });
  await symlink(join(repoRoot, "node_modules"), join(source, "node_modules"));
  const binary = join(buildDir, "gato");
  await $`bun run build --outfile ${binary}`.cwd(source).quiet();
  await rm(source, { recursive: true });
  return binary;
}

test("§5 the harness build contains the default prompts", async () => {
  world = await createWorld();
  const buildDir = await tempDir("gato-build-");
  const binary = await buildFromCopy(buildDir);
  const app = await startApp(
    { ...world.baseEnv, ...world.telegramEnv },
    { command: [binary], cwd: await tempDir("gato-cwd-") },
  );
  try {
    expect(app.started).toBe(true);
    world.telegram.push(42, { text: "Hi" });
    await waitUntil(() => world.telegram.sent.length);
    expect(systemText(world.llm.mainRequests()[0]!)).toStartWith(
      "You are a customer service agent. You write to one customer through Telegram.",
    );
  } finally {
    await app.stop();
    await rm(buildDir, { recursive: true });
  }
}, 30_000);

test("§5 a changed prompt file applies to the next turn and not to the running turn", async () => {
  world = await createWorld();
  const dir = await writePrompts();
  let changed = false;
  world.llm.respond(async (request) => {
    if (request.messages.some((m) => m.role === "tool")) return { text: "Ok." };
    if (!changed) {
      changed = true;
      await Bun.write(join(dir, "conversation.txt"), "Updated rules.");
      await Bun.write(join(dir, "tool-read-skill.txt"), "Updated tool.");
    }
    return { toolCalls: [{ name: "read_skill", args: { skill: "menu" } }] };
  });
  await world.start({ PROMPTS_DIR: dir });
  world.telegram.push(42, { text: "One" });
  await waitUntil(() => world.telegram.sent.length);
  world.telegram.push(42, { text: "Two" });
  await waitUntil(() => world.telegram.sent.length === 2);

  const [, running, next] = world.llm.mainRequests();
  expect(systemText(running!)).toBe("Mounted rules for Telegram.");
  expect(toolDescription(running!, "read_skill")).toBe(
    "Mounted tool-read-skill.",
  );
  expect(systemText(next!)).toBe("Updated rules.");
  expect(toolDescription(next!, "read_skill")).toBe("Updated tool.");
});

test("§5 a missing or empty prompt file prevents startup and names the file", async () => {
  world = await createWorld();
  const missing = await writePrompts();
  await rm(join(missing, "nudge.txt"));
  const empty = await writePrompts({ "summary.txt": " \n" });

  const first = await world.start({ PROMPTS_DIR: missing });
  expect(first.started).toBe(false);
  expect(first.startError).toContain(join(missing, "nudge.txt"));
  const second = await world.start({ PROMPTS_DIR: empty });
  expect(second.started).toBe(false);
  expect(second.startError).toContain(join(empty, "summary.txt"));
});

test("§5 a prompt that becomes missing or empty fails the turn visibly", async () => {
  world = await createWorld();
  const dir = await writePrompts();
  await world.start({ PROMPTS_DIR: dir });
  await rm(join(dir, "conversation.txt"));
  world.telegram.push(42, { text: "Hi" });
  const missing = await turnEntry("42");
  await Bun.write(join(dir, "conversation.txt"), "Rules.");
  await Bun.write(join(dir, "continue.txt"), "");
  world.telegram.push(43, { text: "Hi" });
  const empty = await turnEntry("43");

  expect(missing.meta.outcome).toBe("failed");
  expect(missing.text).toContain(join(dir, "conversation.txt"));
  expect(empty.meta.outcome).toBe("failed");
  expect(empty.text).toContain(join(dir, "continue.txt"));
  expect(world.telegram.sent).toHaveLength(0);
});

const problemLogs = (app: App) =>
  app.logs.filter((l) => l.event === "prompts.problems").map((l) => l.problems);

test("§5 hidden files and folders in a mounted prompts folder are not reported", async () => {
  world = await createWorld();
  const dir = await tempDir("gato-prompts-");
  for (const name of promptNames) {
    await Bun.write(
      join(dir, "..2024_01_01", `${name}.txt`),
      `Mounted ${name}.`,
    );
    await symlink(`..data/${name}.txt`, join(dir, `${name}.txt`));
  }
  await symlink("..2024_01_01", join(dir, "..data"));
  await Bun.write(join(dir, "notes.txt"), "x");
  await Bun.write(join(dir, "old/summary.txt"), "x");
  const app = await world.start({ PROMPTS_DIR: dir });
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length);

  expect(systemText(world.llm.mainRequests()[0]!)).toBe(
    "Mounted conversation.",
  );
  expect(problemLogs(app)).toEqual([
    [
      "notes.txt is not a prompt file and is not used",
      "old/summary.txt is not a prompt file and is not used",
    ],
  ]);
});

test("§5 a file that appears in the mounted prompts folder is reported once", async () => {
  world = await createWorld();
  const dir = await writePrompts();
  const app = await world.start({ PROMPTS_DIR: dir });
  await Bun.write(join(dir, "notes.txt"), "x");
  world.telegram.push(42, { text: "Hi" });
  await app.waitForLog("prompts.problems");
  await waitUntil(() => world.telegram.sent.length);

  expect(problemLogs(app)).toEqual([
    ["notes.txt is not a prompt file and is not used"],
  ]);
});
