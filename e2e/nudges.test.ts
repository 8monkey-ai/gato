import { expect, test } from "bun:test";

import { messages, readChat } from "./support/app.ts";
import type { ChatRequest } from "./support/fake-gateway.ts";
import { messageEvent, postWebhook } from "./support/fake-respondio.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

const minute = 60_000;
const nudging = { NUDGE_ENABLED: "true", NUDGE_CHECK_INTERVAL_SECONDS: "0.2" };
const nudgePromptStart = "This is an automatic follow-up prompt";

function entry(at: number, meta: Record<string, unknown>, text: string) {
  return `[${new Date(at).toISOString()}] prepared ${JSON.stringify(meta)}\n> ${text}`;
}

/** A conversation whose customer wrote `customerAgo` ms ago, and the agent answered `agentAfter` ms later. */
function history(
  customerAgo: number,
  agentAfter: number,
  extra: string[] = [],
) {
  const customerAt = Date.now() - customerAgo;
  return (
    [
      entry(
        customerAt,
        { type: "message", id: "c1", role: "customer", ref: "1" },
        "Is it available?",
      ),
      entry(
        customerAt + agentAfter,
        {
          type: "message",
          id: "a1",
          role: "agent",
          delivery: "sent",
          ref: "2",
        },
        "Yes, it is.",
      ),
      ...extra,
    ].join("\n") + "\n"
  );
}

const isNudge = (request: ChatRequest) =>
  JSON.stringify(request.messages.at(-1)).includes(nudgePromptStart);

test("§8 acceptance: with agent activity at minute 6, there is no nudge at minute 34", async () => {
  const { gateway } = await startHarness({
    env: nudging,
    data: { "telegram/120/chat.txt": history(34 * minute, 6 * minute) },
  });
  await Bun.sleep(1000);
  expect(gateway.requests).toHaveLength(0);
});

test("§8 acceptance: at minute 35 one nudge runs, after its note, with the nudge prompt as an internal trigger", async () => {
  const { gateway, telegram, dataDir } = await startHarness({
    env: nudging,
    data: { "telegram/121/chat.txt": history(35 * minute, 6 * minute) },
  });
  gateway.script(() => ({ text: "Are you still interested?" }));
  await until(() => telegram.sent().length === 1);
  await Bun.sleep(800);

  expect(gateway.requests).toHaveLength(1);
  expect(gateway.requests[0] && isNudge(gateway.requests[0])).toBe(true);
  const record = await readChat(dataDir, "telegram", "121");
  const kinds = record.slice(2).map((e) => e.meta.kind ?? e.meta.type);
  expect(kinds).toEqual(["nudge", "turn", "message"]);
  expect(record.find((e) => e.meta.kind === "nudge")?.meta.author).toBe(
    "agent",
  );
  expect(record.find((e) => e.meta.type === "turn")?.meta.trigger).toBe(
    "nudge",
  );
  expect(
    messages(record).filter((m) => m.meta.role === "customer"),
  ).toHaveLength(1);
});

test("§8 nudges: an earlier nudge prompt never reaches the model again", async () => {
  const { gateway, telegram } = await startHarness({
    env: nudging,
    data: { "telegram/122/chat.txt": history(35 * minute, 6 * minute) },
  });
  await until(() => telegram.sent().length === 1);
  telegram.push(122, { text: "yes I am" });
  await until(() => telegram.sent().length === 2);
  expect(JSON.stringify(gateway.requests[1]?.messages)).not.toContain(
    nudgePromptStart,
  );
});

test("§8 nudges: a failed nudge leaves an internal note and no error handoff", async () => {
  const { gateway, respondio, dataDir } = await startHarness({
    channels: "respondio",
    env: nudging,
    data: { "respondio/123/chat.txt": history(35 * minute, 6 * minute) },
  });
  gateway.script(() => ({ status: 400 }));
  const record = await until(async () => {
    const entries = await readChat(dataDir, "respondio", "123");
    return entries.some((e) => e.meta.kind === "nudge-failed") && entries;
  });
  expect(record.find((e) => e.meta.kind === "nudge-failed")?.text).toStartWith(
    "Nudge failed",
  );
  await Bun.sleep(600);
  expect(respondio.callsTo("/tag")).toHaveLength(0);
  expect(gateway.requests).toHaveLength(1);
});

test("§8 nudges: human-owned conversations, conversations without customer activity, and disabled nudges get none", async () => {
  const onlyAgent =
    entry(
      Date.now() - 60 * minute,
      { type: "message", id: "a1", role: "agent", delivery: "sent" },
      "Hello!",
    ) + "\n";
  const owned = await startHarness({
    channels: "respondio",
    env: nudging,
    data: {
      "respondio/124/chat.txt": history(35 * minute, 6 * minute),
      "respondio/125/chat.txt": onlyAgent,
    },
  });
  owned.respondio.assignees.set(124, 900);
  const disabled = await startHarness({
    data: { "telegram/126/chat.txt": history(35 * minute, 6 * minute) },
  });
  await Bun.sleep(1000);
  expect(owned.gateway.requests).toHaveLength(0);
  expect(disabled.gateway.requests).toHaveLength(0);
  expect(owned.respondio.callsTo("/contact/id:124").length).toBeGreaterThan(0);
});

test("§8 nudges: none run outside the permitted hours", async () => {
  const hour = new Date().getUTCHours();
  const pad = (h: number) => String(h % 24).padStart(2, "0");
  const { gateway } = await startHarness({
    env: { ...nudging, NUDGE_HOURS: `${pad(hour + 2)}:00-${pad(hour + 3)}:00` },
    data: { "telegram/127/chat.txt": history(35 * minute, 6 * minute) },
  });
  await Bun.sleep(1000);
  expect(gateway.requests).toHaveLength(0);
});

test("§8 restart: a committed nudge is not repeated, even when the attempt failed", async () => {
  const note = entry(
    Date.now() - 30_000,
    { type: "note", id: "n1", author: "agent", kind: "nudge" },
    "Nudge",
  );
  const { gateway } = await startHarness({
    env: nudging,
    data: { "telegram/128/chat.txt": history(36 * minute, 6 * minute, [note]) },
  });
  await Bun.sleep(1000);
  expect(gateway.requests).toHaveLength(0);
});

test("§8 nudges: milestones count from the customer message and the next one follows", async () => {
  const { gateway, app } = await startHarness({
    channels: "respondio",
    env: { ...nudging, NUDGE_MILESTONES: "1s,3s" },
  });
  gateway.script(() => ({ text: "Hi!" }));
  await postWebhook(app.url, messageEvent({ contact: 129, text: "hello" }));
  await until(() => gateway.requests.length === 3, 8000);
  expect(gateway.requests.map((r) => isNudge(r))).toEqual([false, true, true]);
  await Bun.sleep(1000);
  expect(gateway.requests).toHaveLength(3);
});
