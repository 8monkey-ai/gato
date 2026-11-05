import { expect, test } from "bun:test";

import { logEvents, tempDir, waitFor } from "./support/app.ts";
import { useHarness } from "./support/fixture.ts";
import { conversation, mainRequests } from "./support/gateway.ts";
import { agentUserId } from "./support/respondio.ts";
import { readChat, readState, writeChat } from "./support/setup.ts";

const f = useHarness(["tg", "rio"]);
const minute = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const fast = { NUDGE_CHECK_INTERVAL: "150ms" };

function chatWith(customerAgo: number, agentAgo?: number) {
  const entries: object[] = [
    {
      kind: "message",
      id: "c1",
      at: ago(customerAgo),
      role: "customer",
      ref: "1",
      text: "Is it in stock?",
    },
  ];
  if (agentAgo !== undefined)
    entries.push({
      kind: "message",
      id: "a1",
      at: ago(agentAgo),
      role: "agent",
      text: "Let me check",
      delivery: "sent",
    });
  return entries;
}

async function prepared(
  chats: Record<string, object[]>,
  connection = "tg",
  state?: object,
) {
  const dataDir = await tempDir();
  for (const [chat, entries] of Object.entries(chats))
    await writeChat(dataDir, connection, chat, entries, state);
  return dataDir;
}

const notes = async (
  dataDir: string,
  chat: string,
  type: string,
  connection = "tg",
) =>
  (await readChat(dataDir, connection, chat)).filter(
    (entry) => entry.type === type,
  );

test("§8 defaults: no nudge at minute 34 after agent activity at minute 6, but one at minute 35, with the note before the agent continues", async () => {
  const dataDir = await prepared({
    "34": chatWith(34 * minute, 28 * minute),
    "35": chatWith(35 * minute, 29 * minute),
  });
  f.gateway.reply({ text: "Still there?" });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(() => f.telegram.sentTexts(35).length === 1);
  await Bun.sleep(500);
  expect(f.telegram.sentTexts(34)).toHaveLength(0);
  expect(conversation(mainRequests(f.gateway)[0]!).at(-1)).toEqual([
    "user",
    "Nudge",
  ]);
  const entries = await readChat(dataDir, "tg", "35");
  const kinds = entries.slice(2).map((entry) => entry.type ?? entry.kind);
  expect(kinds.slice(0, 2)).toEqual(["nudge", "trigger"]);
  expect(entries.find((entry) => entry.type === "nudge")?.byAgent).toBe(true);
});

test("§8 at most one attempt per check; milestones count from the customer message, and the prompt never counts as customer activity", async () => {
  const dataDir = await prepared({ "1": chatWith(40 * minute) });
  f.gateway.reply({ text: "Any news?" });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  await Bun.sleep(700);
  expect(await notes(dataDir, "1", "nudge")).toHaveLength(1);
  expect(f.gateway.requests).toHaveLength(1);
});

test("§8 a failed nudge writes an internal failure note without an error handoff and is not repeated", async () => {
  const dataDir = await prepared({ "1": chatWith(40 * minute, 39 * minute) });
  f.gateway.reply({ status: 500 });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(
    async () => (await notes(dataDir, "1", "nudge-failed")).length === 1,
  );
  await Bun.sleep(500);
  expect((await notes(dataDir, "1", "nudge-failed"))[0]!.text).toStartWith(
    "Nudge failed.",
  );
  expect(await notes(dataDir, "1", "error")).toHaveLength(0);
  expect(await notes(dataDir, "1", "nudge")).toHaveLength(1);
  expect((await readState(dataDir, "tg", "1")).assignee).toBe("agent");
});

test("§8 expiry records the elapsed time, applies handoff and expired labels, and stops nudges", async () => {
  const dataDir = await prepared({
    "1": chatWith(14 * 60 * minute, 13 * 60 * minute),
  });
  await f.start({ DATA_DIR: dataDir, ...fast });
  const expired = await waitFor(
    async () => (await notes(dataDir, "1", "expired"))[0],
  );
  expect(expired.text).toBe("Expired after 14h 0m without a customer reply.");
  await Bun.sleep(400);
  const state = await readState(dataDir, "tg", "1");
  expect(state.labels).toEqual(["handoff", "expired"]);
  expect(await notes(dataDir, "1", "nudge")).toHaveLength(0);
});

test("§8 expiry needs agent activity after the latest customer message", async () => {
  const dataDir = await prepared({ "1": chatWith(14 * 60 * minute) });
  f.gateway.reply({ text: "Hello?" });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(async () => (await notes(dataDir, "1", "nudge")).length === 1);
  expect(await notes(dataDir, "1", "expired")).toHaveLength(0);
});

test("§8 the exemption label prevents expiry but not nudges", async () => {
  const state = {
    assignee: "agent",
    open: true,
    labels: ["out-of-scope-unsolved"],
    profile: {},
    pendingReply: false,
  };
  const dataDir = await prepared(
    { "1": chatWith(14 * 60 * minute, 14 * 60 * minute - 10 * minute) },
    "tg",
    state,
  );
  f.gateway.reply({ text: "Hello?" });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(async () => (await notes(dataDir, "1", "nudge")).length === 1);
  await Bun.sleep(300);
  expect(await notes(dataDir, "1", "expired")).toHaveLength(0);
});

test("§8 nudges and expiry can be switched off independently, and permitted hours limit nudges", async () => {
  const dataDir = await prepared({
    "1": chatWith(40 * minute),
    "2": chatWith(14 * 60 * minute, 13 * 60 * minute),
  });
  const hour = Number(new Date().toISOString().slice(11, 13));
  const closed = hour < 12 ? "13-24" : "0-11";
  await f.start({
    DATA_DIR: dataDir,
    ...fast,
    NUDGE_HOURS: closed,
    EXPIRY_ENABLED: "false",
  });
  await Bun.sleep(600);
  expect(await notes(dataDir, "1", "nudge")).toHaveLength(0);
  expect(await notes(dataDir, "2", "expired")).toHaveLength(0);
  await f.restart({
    NUDGE_HOURS: "0-24",
    EXPIRY_ENABLED: "true",
    NUDGES_ENABLED: "false",
  });
  await waitFor(
    async () => (await notes(dataDir, "2", "expired")).length === 1,
  );
  await Bun.sleep(300);
  expect(await notes(dataDir, "1", "nudge")).toHaveLength(0);
});

test("§8 closed or human-owned conversations get no nudges", async () => {
  const closed = {
    assignee: "agent",
    open: false,
    labels: [],
    profile: {},
    pendingReply: false,
  };
  const dataDir = await prepared({ "1": chatWith(40 * minute) }, "tg", closed);
  await writeChat(dataDir, "tg", "2", chatWith(40 * minute), {
    ...closed,
    open: true,
    assignee: "human",
  });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await Bun.sleep(600);
  expect(await notes(dataDir, "1", "nudge")).toHaveLength(0);
  expect(await notes(dataDir, "2", "nudge")).toHaveLength(0);
});

test("§8 restart does not repeat committed attempts", async () => {
  const dataDir = await prepared({ "1": chatWith(40 * minute) });
  f.gateway.reply({ text: "Any news?" });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  await f.restart();
  await Bun.sleep(600);
  expect(await notes(dataDir, "1", "nudge")).toHaveLength(1);
});

test("§8 respond.io: ownership is checked again before acting, and the nudge note becomes a comment", async () => {
  const dataDir = await prepared(
    { "71": chatWith(40 * minute), "72": chatWith(40 * minute) },
    "rio",
  );
  f.respond.contacts.set("71", { assignee: 12, status: "open" });
  f.respond.contacts.set("72", { assignee: agentUserId, status: "open" });
  f.gateway.reply({ text: "Following up" });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(() => f.respond.sentTexts("72").length === 1);
  await Bun.sleep(300);
  expect(f.respond.sentTexts("71")).toHaveLength(0);
  expect((await readState(dataDir, "rio", "71")).assignee).toBe("human");
  expect(f.respond.comments("72")).toEqual(["Nudge"]);
});

test("§8 respond.io: unavailable exemption labels are logged, expiry is skipped for that check, and later checks continue", async () => {
  const dataDir = await prepared(
    { "73": chatWith(14 * 60 * minute, 13 * 60 * minute) },
    "rio",
  );
  f.respond.fail({ path: /^\/contact\/id:73$/, status: 500, skip: 1 });
  f.gateway.reply({ text: "Following up" });
  await f.start({ DATA_DIR: dataDir, ...fast });
  await waitFor(
    async () => (await notes(dataDir, "73", "expired", "rio")).length === 1,
  );
  expect(logEvents(f.app.logs, "expiry.labels_unavailable")).toHaveLength(1);
  expect(f.respond.tags.get("73")).toEqual(["handoff", "expired"]);
});

test("§4 omitting tool activity also omits obsolete nudge prompts but keeps the current one", async () => {
  const entries = [
    ...chatWith(40 * minute),
    {
      kind: "trigger",
      id: "old",
      at: ago(39 * minute),
      turn: "earlier",
      text: "Old nudge prompt",
    },
  ];
  const dataDir = await prepared({ "1": entries });
  f.gateway.reply({ text: "Hello?" });
  await f.start({
    DATA_DIR: dataDir,
    ...fast,
    INCLUDE_TOOL_ACTIVITY: "false",
    NUDGE_INSTRUCTION: "Please continue",
  });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(conversation(mainRequests(f.gateway)[0]!)).toEqual([
    ["user", "Is it in stock?"],
    ["user", "Please continue"],
  ]);
});
