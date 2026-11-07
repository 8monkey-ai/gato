import { afterEach, expect, test } from "bun:test";

import { minutesAgo, readChat, waitUntil, writeChat } from "./support/app.ts";
import { lastUserText, type LlmRequest } from "./support/fake-openrouter.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const fast = { NUDGES_ENABLED: "true", NUDGES_CHECK_INTERVAL_SECONDS: "0.2" };
const isNudge = (request: LlmRequest) =>
  lastUserText(request).startsWith("(Automatic follow-up");
const stalled = (
  customerMinutesAgo: number,
  agentMinutesAgo: number,
) => `[${minutesAgo(customerMinutesAgo)}] customer {"ref":"c1"}
  Can I order beans?

[${minutesAgo(agentMinutesAgo)}] agent {"delivery":"sent"}
  Which beans do you like?
`;
const nudgeRequests = () => world.llm.requests.filter(isNudge);

async function startWith(
  chats: Record<string, string>,
  env: Record<string, string> = {},
  channels: "telegram" | "respondio" = "telegram",
) {
  world = await createWorld();
  const connection =
    channels === "telegram" ? world.telegram.connectionId : "respondio-main";
  for (const [contact, text] of Object.entries(chats))
    await writeChat(world.dataDir, connection, contact, text);
  world.llm.respond((request) =>
    isNudge(request) ? { text: "Still interested?" } : { text: "Hi." },
  );
  return world.start({ ...fast, ...env }, channels);
}

test("§8 defaults give no nudge at minute 34 after agent activity at minute 6, but one at minute 35", async () => {
  await startWith({ "34": stalled(34, 28), "35": stalled(35.2, 29.2) });
  await waitUntil(() => world.telegram.sent.length, 3000);
  await Bun.sleep(600);

  expect(world.telegram.sent.map((s) => [s.chat_id, s.text])).toEqual([
    ["35", "Still interested?"],
  ]);
  const chat = await readChat(world.dataDir, world.telegram.connectionId, "35");
  expect(chat.map((e) => e.tag)).toEqual([
    "customer",
    "agent",
    "note",
    "agent",
    "turn",
  ]);
  expect(chat[2]?.text).toBe("Nudge");
  expect(chat.at(-1)?.meta).toMatchObject({
    trigger: "nudge",
    outcome: "completed",
  });
});

test("§8 the nudge prompt is a private user-side trigger that is never recorded as customer input", async () => {
  await startWith({ "35": stalled(35.2, 29.2) });
  await waitUntil(() => world.telegram.sent.length, 3000);
  const [request] = nudgeRequests();
  expect(request!.messages.at(-1)?.role).toBe("user");
  const chat = await readChat(world.dataDir, world.telegram.connectionId, "35");
  expect(chat.filter((e) => e.tag === "customer")).toHaveLength(1);
});

test("§8 configured milestones are measured from the latest real customer message", async () => {
  world = await createWorld();
  world.llm.respond((request) =>
    isNudge(request) ? { text: "Anything else?" } : { text: "Hello." },
  );
  await world.start({ ...fast, NUDGES_MILESTONES_MINUTES: "0.02" });
  world.telegram.push(42, { text: "Hi" });

  await waitUntil(() => world.telegram.sent.length === 2, 4000);
  await Bun.sleep(600);
  expect(world.telegram.sent.map((s) => s.text)).toEqual([
    "Hello.",
    "Anything else?",
  ]);
});

test("§8 a failed nudge leaves an internal note, no error handoff, and is not repeated", async () => {
  const app = await startWith({ "5": stalled(36, 30) }, {}, "respondio");
  world.llm.respond(() => ({ status: 400 }));
  await app.waitForLog("turn.ended", () => true, 3000);
  await Bun.sleep(600);

  const chat = await readChat(world.dataDir, "respondio-main", "5");
  expect(chat.find((e) => e.tag === "turn")?.text).toStartWith(
    "Nudge failed: ",
  );
  expect(chat.filter((e) => e.tag === "note")).toHaveLength(1);
  expect(world.respondio.comments).toEqual([{ contact: "5", text: "Nudge" }]);
  expect(world.respondio.tags).toHaveLength(0);
});

test("§8 human-owned conversations and conversations without customer activity get no nudge", async () => {
  const operatorOnly = `[${minutesAgo(40)}] operator {"sender":"user:3"}\n  Hello?\n`;
  await startWith({ "5": stalled(36, 30), "6": operatorOnly }, {}, "respondio");
  world.respondio.assign("5", 3);
  await Bun.sleep(800);
  expect(world.llm.requests).toHaveLength(0);
});

test("§8 no nudges outside permitted hours or when switched off", async () => {
  const hour = (new Date().getUTCHours() + 2) % 24;
  const pad = (h: number) => String(h).padStart(2, "0");
  await startWith(
    { "35": stalled(36, 30) },
    { NUDGES_PERMITTED_HOURS: `${pad(hour)}:00-${pad((hour + 1) % 24)}:00` },
  );
  await Bun.sleep(600);
  expect(world.llm.requests).toHaveLength(0);
  await world.close();

  await startWith({ "35": stalled(36, 30) }, { NUDGES_ENABLED: "false" });
  await Bun.sleep(600);
  expect(world.llm.requests).toHaveLength(0);
});

test("§8 a restart does not repeat a committed attempt", async () => {
  const committed = `${stalled(36, 30)}\n[${minutesAgo(0.5)}] note {"author":"agent"}\n  Nudge\n`;
  await startWith({ "35": committed });
  await Bun.sleep(800);
  expect(world.llm.requests).toHaveLength(0);
});
