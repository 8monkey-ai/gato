import { expect, test } from "bun:test";

import { waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import {
  conversation,
  mainRequests,
  preparationRequests,
} from "./support/gateway.ts";
import {
  ago,
  ask,
  day,
  history,
  prepareChat,
  replyWithSummary,
} from "./support/history.ts";
import { readChat } from "./support/setup.ts";

const f = useTelegram();

const at = (offsetMs: number) => ago(5 * day - offsetMs);
const card = {
  id: "f1",
  category: "image",
  source: "s",
  name: "card.jpg",
  file: "attachments/f1.jpg",
  prepared: { model: "m", text: "A broken card", at: ago(day) },
};
const privateEntries = [
  {
    kind: "note",
    id: "n1",
    at: at(2000),
    type: "handoff",
    text: "Internal reason",
  },
  {
    kind: "tool-call",
    id: "t1",
    at: at(3000),
    turn: "x",
    callId: "k",
    tool: "read_skill",
    input: {},
  },
  {
    kind: "tool-result",
    id: "t2",
    at: at(3500),
    turn: "x",
    callId: "k",
    tool: "read_skill",
    output: "Tool secret",
  },
  {
    kind: "message",
    id: "a2",
    at: at(4000),
    role: "agent",
    text: "Never delivered",
    delivery: "failed",
  },
  { kind: "trigger", id: "g1", at: at(5000), turn: "y", text: "Nudge" },
  {
    kind: "message",
    id: "c2",
    at: at(6000),
    role: "customer",
    ref: "2",
    attachments: [card],
  },
];

test("§4 summary input excludes internal notes, tool activity, undelivered output and nudge prompts, and uses saved interpretations", async () => {
  const entries = [...history(5 * day), ...privateEntries];
  const dataDir = await prepareChat(entries);
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir);
  const input = conversation(preparationRequests(f.gateway)[0]!)
    .map(([, text]) => text)
    .join("\n");
  expect(input).toContain(
    'Customer: [image attachment "card.jpg": A broken card]',
  );
  for (const hidden of [
    "Internal reason",
    "Tool secret",
    "Never delivered",
    "Nudge",
  ]) {
    expect(input).not.toContain(hidden);
  }
  const record = await readChat(dataDir, "tg", "1");
  expect(record.filter((entry) => entry.type !== "outcome")).toHaveLength(
    entries.length + 2,
  );
});

test("§4 the recent-contact-history option limits context to one calendar month without truncating the record", async () => {
  const old = {
    kind: "message",
    id: "o1",
    at: ago(40 * day),
    role: "customer",
    ref: "0",
    text: "Ancient question",
  };
  const dataDir = await prepareChat([old, ...history(2 * day)]);
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir, { RECENT_CONTACT_HISTORY: "true" });
  const texts = conversation(mainRequests(f.gateway)[0]!).map(
    ([, text]) => text,
  );
  expect(texts).toEqual(["I need a new card", "Sure", "Any update?"]);
  expect((await readChat(dataDir, "tg", "1"))[0]!.text).toBe(
    "Ancient question",
  );
});

const toolHistory = [
  {
    kind: "message",
    id: "c1",
    at: ago(60_000),
    role: "customer",
    ref: "1",
    text: "Refund?",
  },
  {
    kind: "tool-call",
    id: "t1",
    at: ago(59_000),
    turn: "x",
    callId: "call_1",
    tool: "read_skill",
    input: { path: "skills/refunds" },
  },
  {
    kind: "tool-result",
    id: "t2",
    at: ago(58_000),
    turn: "x",
    callId: "call_1",
    tool: "read_skill",
    output: "Refunds take 5 days.",
  },
  {
    kind: "message",
    id: "a1",
    at: ago(57_000),
    role: "agent",
    text: "5 days",
    delivery: "sent",
  },
];

test("§4 tool activity is included by default and never runs again", async () => {
  const dataDir = await prepareChat(toolHistory);
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir);
  const roles = mainRequests(f.gateway)[0]!.messages.map(
    (message) => message.role,
  );
  expect(roles).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "assistant",
    "user",
  ]);
  const calls = (await readChat(dataDir, "tg", "1")).filter(
    (entry) => entry.kind === "tool-call",
  );
  expect(calls).toHaveLength(1);
});

test("§4 tool activity can be omitted by configuration", async () => {
  const dataDir = await prepareChat(toolHistory);
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir, { INCLUDE_TOOL_ACTIVITY: "false" });
  await waitFor(() => mainRequests(f.gateway).length === 1);
  const roles = mainRequests(f.gateway)[0]!.messages.map(
    (message) => message.role,
  );
  expect(roles).toEqual(["system", "user", "assistant", "user"]);
});
