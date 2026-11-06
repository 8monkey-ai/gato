import { afterEach, expect, test } from "bun:test";

import { readChat, waitUntil } from "./support/app.ts";
import { contentText, type LlmRequest } from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const chat = () => readChat(world.dataDir, "respondio-main", "5");
const turn = () =>
  waitUntil(async () => (await chat()).find((e) => e.tag === "turn"));
const toolNames = (request: LlmRequest) =>
  (request.tools ?? []).map((t) => t.function.name).sort();

async function respondioTurn(
  handler: Parameters<World["llm"]["respond"]>[0],
  text = "Hi",
) {
  world = await createWorld();
  world.llm.respond(handler);
  const app = await world.start({}, "respondio");
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text }),
    world.respondio.signingKey,
  );
  return app;
}

test("§7 the handoff tool saves an English reason and applies the handoff and out-of-scope labels", async () => {
  const app = await respondioTurn((request) =>
    request.messages.some((m) => m.role === "tool")
      ? { text: "A colleague will help you soon." }
      : {
          toolCalls: [
            {
              name: "handoff_to_colleague",
              args: { reason: "Refund needs approval" },
            },
          ],
        },
  );
  await turn();

  expect(world.respondio.tags).toEqual([
    { contact: "5", tags: ["handoff", "out-of-scope"] },
  ]);
  expect(world.respondio.comments).toEqual([
    { contact: "5", text: "Handoff: Refund needs approval" },
  ]);
  expect((await chat()).find((e) => e.tag === "note")?.text).toBe(
    "Handoff: Refund needs approval",
  );
  expect(world.respondio.sent.map((s) => s.message.text)).toEqual([
    "A colleague will help you soon.",
  ]);

  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Still there?" }),
    world.respondio.signingKey,
  );
  await waitUntil(() => world.respondio.sent.length === 2);
});

test("§7 channels without handoff offer no handoff tool", async () => {
  world = await createWorld();
  await world.start();
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length);
  expect(toolNames(world.llm.mainRequests()[0]!)).toEqual(["read_skill"]);
});

test("§7 an unrecoverable error applies the handoff and error labels without a customer message", async () => {
  await respondioTurn(() => ({ status: 400 }));
  expect((await turn()).meta.outcome).toBe("failed");
  await waitUntil(() => world.respondio.tags.length);

  expect(world.respondio.tags).toEqual([
    { contact: "5", tags: ["handoff", "error"] },
  ]);
  expect(world.respondio.comments[0]?.text).toStartWith("Error: ");
  expect(world.respondio.sent).toHaveLength(0);
});

test("§7 on a channel without handoff the error is saved and logged", async () => {
  world = await createWorld();
  world.llm.respond(() => ({ status: 400 }));
  const app = await world.start();
  world.telegram.push(42, { text: "Hi" });

  await app.waitForLog("turn.ended", (l) => l.outcome === "failed");
  const entries = await readChat(
    world.dataDir,
    world.telegram.connectionId,
    "42",
  );
  expect(entries.find((e) => e.tag === "turn")?.text).toBeTruthy();
  expect(world.telegram.sent).toHaveLength(0);
});

test("§7 a deliberate skip is recorded with an explanation and no handoff", async () => {
  await respondioTurn(() => ({ text: "" }), "ok thanks");
  const entry = await turn();
  expect([entry.meta.outcome, entry.text]).toEqual([
    "skipped",
    "The agent wrote no reply.",
  ]);
  expect(world.respondio.tags).toHaveLength(0);
});

test("§7 a recoverable tool error is returned to the agent for correction", async () => {
  await respondioTurn((request) => {
    const result = request.messages.find((m) => m.role === "tool");
    if (result)
      return {
        text: contentText(result.content).includes("no skill")
          ? "Fixed it."
          : "?",
      };
    return {
      toolCalls: [{ name: "read_skill", args: { skill: "unknown" } }],
    };
  });
  expect((await turn()).meta.outcome).toBe("completed");
  expect(world.respondio.sent.map((s) => s.message.text)).toEqual([
    "Fixed it.",
  ]);
  expect(world.respondio.tags).toHaveLength(0);
});
